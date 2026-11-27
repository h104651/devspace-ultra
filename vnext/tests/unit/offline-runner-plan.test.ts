import { withDurableGitFence } from '../../scripts/git-mutation-fence';
import { GitBranchAdapter, runGitBranchMutation } from '../../scripts/execute-git-branch-mutations';
import { parseGitBranchIntent, checkGitBranchPreflight } from '../../scripts/plan-git-branch-mutations';
import * as assert from 'assert';
import { planOfflineRunners, buildGitReadArgs } from '../../scripts/plan-offline-runners';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { TaskExecutor } from '../../src/local-agent/task-executor';
import { validateGitReadProfile, parseGitReadTask } from '../../src/local-agent/git-read-plan';

export async function runOfflineRunnerPlanTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0, failed = 0;
  const tools = {
    flutter: 'C:\\Stage Tools\\flutter\\bin\\flutter.bat',
    dart: 'C:\\Stage Tools\\flutter\\bin\\dart.bat',
    gradle: 'C:\\Fixture\\android\\gradlew.bat',
    npm: 'C:\\Stage Tools\\node\\npm.cmd',
    node: 'C:\\Stage Tools\\node\\node.exe',
    python: 'C:\\Fixture\\venv\\Scripts\\python.exe',
    java: 'C:\\Stage Tools\\java\\bin\\java.exe',
    adb: 'C:\\Stage Tools\\sdk\\platform-tools\\adb.exe'
  };
  const cases: Array<() => void> = [
    () => {
      const head = 'a'.repeat(40), targetHead = 'b'.repeat(40);
      const create = { projectId: 'fixture', operation: 'git_branch_create', expectedBranch: 'main', expectedHead: head, branch: 'feat/fixture' };
      const snapshot = { currentBranch: 'main', head, clean: true, operationInProgress: false, targetHead: null, targetCheckedOutElsewhere: false };
      assert.deepStrictEqual(checkGitBranchPreflight(create, ['feat/fixture'], snapshot), create);
      const change = { ...create, operation: 'git_switch', expectedTargetHead: targetHead };
      assert.deepStrictEqual(checkGitBranchPreflight(change, ['feat/fixture'], { ...snapshot, targetHead }), change);
      for (const bad of ['main','master','release/v1','--force','feat/../x','feat/x.lock','feat/x@{1}','feat/CON','feat/con','feat/x\\y','feat//x','feat/x y','feat/x;push']) {
        assert.throws(() => parseGitBranchIntent({ ...create, branch: bad }));
      }
      for (const extra of [{ args: ['push'] }, { force: true }, { remote: 'origin' }, { expectedTargetHead: head }, { env: {} }]) {
        assert.throws(() => parseGitBranchIntent({ ...create, ...extra }), /FIELDS/);
      }
      assert.throws(() => parseGitBranchIntent({ ...create, expectedHead: 'HEAD' }), /OBJECT_ID/);
      assert.throws(() => parseGitBranchIntent({ ...create, operation: 'git_switch' }), /FIELDS/);
      assert.throws(() => parseGitBranchIntent({ ...change, expectedTargetHead: 'a'.repeat(64) }), /FORMAT/);
      assert.throws(() => checkGitBranchPreflight(create, [], snapshot), /POLICY/);
      for (const state of [{ clean: false }, { head: targetHead }, { currentBranch: '' }, { operationInProgress: true }, { targetCheckedOutElsewhere: true }, { clean: undefined }]) {
        assert.throws(() => checkGitBranchPreflight(create, ['feat/fixture'], { ...snapshot, ...state }), /STATE/);
      }
      assert.throws(() => checkGitBranchPreflight(create, ['feat/fixture'], { ...snapshot, targetHead }), /TARGET_CONFLICT/);
      assert.throws(() => checkGitBranchPreflight(change, ['feat/fixture'], snapshot), /TARGET_CONFLICT/);
      assert.throws(() => checkGitBranchPreflight(change, ['feat/fixture'], { ...snapshot, targetHead: head }), /TARGET_CONFLICT/);
    },
    () => {
      const p = planOfflineRunners({ tools, profiles:['flutter_analyze','flutter_test','flutter_build_apk_debug','dart_format_check'], workingRelativePath:'app/mobile' });
      assert.deepStrictEqual(p.commands.test.flutter_analyze.args,['analyze','--no-pub']);
      assert.deepStrictEqual(p.commands.build.flutter_build_apk_debug.args,['build','apk','--debug','--no-pub']);
      assert.strictEqual(p.commands.test.dart_format_check.workingRelativePath,'app/mobile');
      assert.strictEqual(p.activationAuthorized,false);
      assert.ok(!('permissions' in p));
    },
    () => {
      const p=planOfflineRunners({tools,profiles:['gradle_test','gradle_assemble_debug','npm_test','npm_build','python_pytest','node_version','java_version','adb_version','dart_analyze','dart_test','python_version']});
      assert.deepStrictEqual(p.commands.test.gradle_test.args,['--offline','--no-daemon','test']);
      assert.deepStrictEqual(p.commands.test.python_pytest.args,['-I','-m','pytest']);
      assert.deepStrictEqual(p.commands.build.npm_build.args,['--offline','--ignore-scripts','run','build']);
      assert.strictEqual(p.selections.length,11);
    },
    () => {
      assert.throws(()=>planOfflineRunners({tools,profiles:['npm_ci_offline']}),/Dependency mutation/);
      const p=planOfflineRunners({tools,profiles:['npm_ci_offline','flutter_pub_get_offline'],allowDependencyMutation:true});
      assert.deepStrictEqual(p.commands.build.npm_ci_offline.args,['ci','--offline','--ignore-scripts','--no-audit','--no-fund']);
      assert.ok(p.selections.every(s=>s.dependencyMutation));
    },
    () => {
      for(const id of ['__proto__','constructor','git_push','flutter_build_aab','flutter_build_apk_release','adb_shell','pip_install','npm_arbitrary'])
        assert.throws(()=>planOfflineRunners({tools,profiles:[id]}),/Unknown/);
      assert.throws(()=>planOfflineRunners({tools,profiles:['node_version','node_version']}),/duplicate/);
    },
    () => {
      for(const bad of ['node.exe','\\\\server\\share\\node.exe','C:\\a\\..\\node.exe','C:\\a&b\\node.exe','C:\\a\\node.exe:stream','C:\\a\\cmd.exe'])
        assert.throws(()=>planOfflineRunners({tools:{node:bad},profiles:['node_version']}),/explicit local Windows tool path/);
      assert.throws(()=>planOfflineRunners({tools:{},profiles:['node_version']}),/Missing/);
    },
    () => {
      for(const bad of ['../app','app/../x','C:/app','/app','app//x','app\\x','app./x'])
        assert.throws(()=>planOfflineRunners({tools,profiles:['node_version'],workingRelativePath:bad}),/normalized/);
    },
    () => {
      for(const field of ['args','env','command','permissions','hostExecution','windowsAppContainerSid'])
        assert.throws(()=>planOfflineRunners({tools,profiles:['node_version'],[field]:true}),/Unexpected/);
      assert.throws(()=>planOfflineRunners({tools:{...tools,secret:'fixture-only'},profiles:['node_version']}),/Unexpected/);
      assert.throws(()=>planOfflineRunners({tools,profiles:['npm_ci_offline'],allowDependencyMutation:'true'}),/boolean/);
    },
    () => {
      const head='a'.repeat(40), base='b'.repeat(40);
      const gitTools={git:'C:\\Stage Tools\\Git\\cmd\\git.exe'};
      const p=planOfflineRunners({tools:gitTools,profiles:['git_log','git_diff_commits'],
        gitSelections:{git_log:{head,limit:2},git_diff_commits:{base,head}}});
      assert.ok(p.commands.test.git_log.args.includes('--max-count=2'));
      assert.deepStrictEqual(p.commands.test.git_diff_commits.args.slice(-3),[base,head,'--']);
      assert.ok(p.commands.test.git_diff_commits.args.includes('--no-ext-diff'));
      assert.ok(p.commands.test.git_diff_commits.args.includes('--no-textconv'));
      validateGitReadProfile('git_log',p.commands.test.git_log.args);
      assert.deepStrictEqual(parseGitReadTask({projectId:'fixture',operation:'git_log',head,limit:2}).args,p.commands.test.git_log.args);
      assert.deepStrictEqual(parseGitReadTask({projectId:'fixture',operation:'git_diff_commits',head,base}).args,p.commands.test.git_diff_commits.args);
      for(const extra of [{args:['push']},{base},{workingRelativePath:'.'},{env:{}},{command:'git push'}])
        assert.throws(()=>parseGitReadTask({projectId:'fixture',operation:'git_log',head,...extra}),/INVALID_ARGUMENT/);
      assert.throws(()=>parseGitReadTask({projectId:'../other',operation:'git_log',head}),/INVALID_ARGUMENT/);
      assert.throws(()=>parseGitReadTask({projectId:'fixture',operation:'git_log',head:'HEAD'}),/INVALID_ARGUMENT/);
      validateGitReadProfile('git_diff_commits',p.commands.test.git_diff_commits.args);
      for(const changed of [
        ['push','origin','main'],
        [...p.commands.test.git_log.args,'--all'],
        p.commands.test.git_diff_commits.args.filter(arg=>arg!=='--no-ext-diff'),
        p.commands.test.git_log.args.map(arg=>arg==='--no-show-signature'?'--show-signature':arg)
      ]) assert.throws(()=>validateGitReadProfile('git_log',changed),/LOCAL_GIT_PROFILE_DENIED/);
      assert.throws(()=>validateGitReadProfile('git_diff_commits',p.commands.test.git_diff_commits.args.filter(arg=>arg!=='--no-textconv')),/LOCAL_GIT_PROFILE_DENIED/);
      for(const bad of ['HEAD','HEAD~1','--all','a..b','a'.repeat(39),'0'.repeat(40),'@{upstream}'])
        assert.throws(()=>buildGitReadArgs('git_log',{head:bad}),/Full lowercase/);
      assert.throws(()=>buildGitReadArgs('git_log',{head,limit:101}),/limit/);
      assert.throws(()=>buildGitReadArgs('git_diff_commits',{base:'a'.repeat(64),head}),/lengths/);
      assert.throws(()=>buildGitReadArgs('git_diff_commits',{base,head,pathspec:'../secret'}),/Unexpected/);
      assert.throws(()=>planOfflineRunners({tools:gitTools,profiles:['git_log']}),/selection/);
    },
    () => {
      // Real disposable Git repository. The exact generated argument vectors
      // must work without invoking a configured external diff or textconv.
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsu-git-read-'));
      try {
        const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull,
          GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'};
        // Avoid inherited caller GIT_DIR/worktree/index/config injection.
        for(const key of Object.keys(env)) {
          if(key.startsWith('GIT_')&&!['GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_OPTIONAL_LOCKS','GIT_NO_LAZY_FETCH','GIT_TERMINAL_PROMPT'].includes(key)) delete env[key];
        }
        const git=(args:string[])=>execFileSync('git',args,{cwd:dir,env,encoding:'utf8',timeout:10000,maxBuffer:262144});
        git(['init','-q','--object-format=sha1']);
        git(['config','user.name','Synthetic Fixture']);
        git(['config','user.email','fixture@example.invalid']);
        git(['config','commit.gpgsign','false']);
        fs.writeFileSync(path.join(dir,'.gitattributes'),'*.txt diff=fixture\n');
        fs.writeFileSync(path.join(dir,'sample.txt'),'before\n');
        git(['add','.']);git(['commit','-qm','first fixture']);
        const base=git(['rev-parse','HEAD']).trim();
        fs.writeFileSync(path.join(dir,'sample.txt'),'after\n');
        git(['add','sample.txt']);git(['commit','-qm','second fixture']);
        const head=git(['rev-parse','HEAD']).trim();
        // If Git tries either configured program, the command fails instead
        // of silently passing a test with a missing marker.
        git(['config','diff.external','dsu-fixture-must-not-launch']);
        git(['config','diff.fixture.command','dsu-fixture-must-not-launch']);
        git(['config','diff.fixture.textconv','dsu-fixture-must-not-launch']);
        fs.writeFileSync(path.join(dir,'sample.txt'),'UNCOMMITTED_SENTINEL\n');
        fs.writeFileSync(path.join(dir,'untracked.txt'),'UNTRACKED_SENTINEL\n');
        const log=git(buildGitReadArgs('git_log',{head,limit:2}));
        assert.ok(log.includes(head)&&log.includes(base)&&log.includes('second fixture'));
        const diff=git(buildGitReadArgs('git_diff_commits',{base,head}));
        assert.ok(diff.includes('-before')&&diff.includes('+after'));
        assert.ok(!diff.includes('UNCOMMITTED_SENTINEL')&&!diff.includes('UNTRACKED_SENTINEL'));
        assert.strictEqual(git(['rev-parse','HEAD']).trim(),head);
        assert.strictEqual(fs.readFileSync(path.join(dir,'sample.txt'),'utf8'),'UNCOMMITTED_SENTINEL\n');
        assert.strictEqual(git(['diff','--cached','--name-only']),'');
      } finally { fs.rmSync(dir,{recursive:true,force:true}); }
    },
    () => {
      const p=planOfflineRunners({tools,profiles:['node_version']});
      p.commands.test.node_version.args[0]='changed';
      assert.deepStrictEqual(planOfflineRunners({tools,profiles:['node_version']}).commands.test.node_version.args,['--version']);
    }
  ];
  for(const test of cases) {
    try { test(); passed++; }
    catch(err) { failed++; console.error('Offline runner planner regression:',err); }
  }
  try {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsu-git-gate-'));
    try {
      const executor=new TaskExecutor({projects:[{projectId:'fixture',root:dir,
        permissions:{read:true,test:true,hostExecution:true},
        commands:{test:{git_log:{executable:process.execPath,args:['--version']}}}}]});
      await assert.rejects(()=>executor.executeTask({capability:'local:run_tests',payload:{projectId:'fixture',runnerId:'git_log'}} as any,()=>{}),/LOCAL_EXECUTION_RUNTIME_BLOCKED/);
      await assert.rejects(()=>executor.executeTask({capability:'local:git_read',payload:{projectId:'fixture',operation:'git_log',head:'a'.repeat(40)}} as any,()=>{}),/LOCAL_EXECUTION_RUNTIME_BLOCKED/);
      passed++;
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  } catch(err) { failed++; console.error('Git offline execution gate regression:',err); }
  try {
    // Real disposable Git fixture: tests the exact candidate argument vectors.
    // This is not a production AppContainer adapter or a durable lease test.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-git-branch-'));
    const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-empty-hooks-'));
    try {
      const env = { ...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:os.devNull,
        GIT_OPTIONAL_LOCKS:'0', GIT_NO_LAZY_FETCH:'1', GIT_TERMINAL_PROMPT:'0' };
      for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_OPTIONAL_LOCKS','GIT_NO_LAZY_FETCH','GIT_TERMINAL_PROMPT'].includes(key)) delete env[key];
      }
      const git = (args: readonly string[]) => execFileSync('git', [...args], { cwd:dir, env, encoding:'utf8', timeout:10000, maxBuffer:262144 });
      git(['init','-q','-b','main','--object-format=sha1']);
      git(['config','user.name','Synthetic Fixture']);
      git(['config','user.email','fixture@example.invalid']);
      git(['config','commit.gpgsign','false']);
      fs.writeFileSync(path.join(dir,'fixture.txt'),'one\n');
      git(['add','fixture.txt']); git(['commit','-qm','first fixture']);
      const head = git(['rev-parse','HEAD']).trim();
      const create = { projectId:'fixture', operation:'git_branch_create', expectedBranch:'main', expectedHead:head, branch:'feat/fixture' };
      let held = false, quarantined = false, failAfterRun = false, raceBeforeRun = false, runs = 0;
      const adapter: GitBranchAdapter = {
        async acquire(projectId) {
          assert.strictEqual(projectId,'fixture');
          if (held || quarantined) throw new Error('LEASE_BLOCKED');
          held = true;
          return {
            approvedTargets:['feat/fixture','fix/uncertain','fix/race'], emptyHooksDirectory:hooks,
            async snapshot(intent) {
              assert.ok(held);
              const currentBranch = git(['symbolic-ref','--short','HEAD']).trim();
              const refs = git(['for-each-ref','--format=%(refname) %(objectname)','refs/heads/' + intent.branch]).trim().split('\n');
              const match = refs.find(ref => ref.startsWith('refs/heads/' + intent.branch + ' '));
              return { currentBranch, head:git(['rev-parse','HEAD']).trim(),
                clean:git(['status','--porcelain','--untracked-files=all','--ignored=matching']).trim() === '',
                operationInProgress:false, targetHead:match ? match.split(' ')[1] : null, targetCheckedOutElsewhere:false };
            },
            async run(args) { assert.ok(held); runs++; if (raceBeforeRun) git(['branch','fix/race']); git(args); if (failAfterRun) throw new Error('SIMULATED_UNCERTAIN_EXIT'); },
            async finish(disposition) { assert.ok(held); held = false; quarantined = disposition === 'quarantine'; }
          };
        }
      };
      const result = await runGitBranchMutation(create, adapter);
      assert.strictEqual(result.head,head);
      assert.strictEqual(git(['symbolic-ref','--short','HEAD']).trim(),'main');
      assert.strictEqual(git(['rev-parse','refs/heads/feat/fixture']).trim(),head);
      assert.strictEqual(held,false);
      await assert.rejects(()=>runGitBranchMutation(create,adapter),/TARGET_CONFLICT/);
      assert.strictEqual(runs,1);
      // Advance target in a synthetic fixture to prove checkout of a distinct
      // commit and actual file contents, not just a symbolic branch change.
      git(['switch','feat/fixture']);
      fs.writeFileSync(path.join(dir,'fixture.txt'),'two\n');
      git(['add','fixture.txt']); git(['commit','-qm','target fixture']);
      const targetHead = git(['rev-parse','HEAD']).trim();
      assert.notStrictEqual(targetHead,head);
      git(['switch','main']);
      fs.writeFileSync(path.join(dir,'fixture.txt'),'dirty\n');
      const change = { ...create, operation:'git_switch', expectedTargetHead:targetHead };
      await assert.rejects(()=>runGitBranchMutation(change,adapter),/STATE_CONFLICT/);
      assert.strictEqual(runs,1);
      fs.writeFileSync(path.join(dir,'fixture.txt'),'one\n');
      await runGitBranchMutation(change,adapter);
      assert.strictEqual(git(['symbolic-ref','--short','HEAD']).trim(),'feat/fixture');
      assert.strictEqual(runs,2);
      assert.strictEqual(git(['rev-parse','HEAD']).trim(),targetHead);
      assert.strictEqual(fs.readFileSync(path.join(dir,'fixture.txt'),'utf8'),'two\n');
      assert.strictEqual(quarantined,false);
      failAfterRun = true;
      const uncertain = { ...create, expectedBranch:'feat/fixture', expectedHead:targetHead, branch:'fix/uncertain' };
      await assert.rejects(()=>runGitBranchMutation(uncertain,adapter),/SIMULATED_UNCERTAIN_EXIT/);
      assert.strictEqual(quarantined,true);
      assert.strictEqual(git(['rev-parse','refs/heads/fix/uncertain']).trim(),targetHead);
      await assert.rejects(()=>runGitBranchMutation(uncertain,adapter),/LEASE_BLOCKED/);
      assert.strictEqual(runs,3);
      // Explicit fixture-only reconciliation, never an automatic runtime retry.
      quarantined = false; failAfterRun = false; raceBeforeRun = true;
      const race = { ...uncertain, branch:'fix/race' };
      await assert.rejects(()=>runGitBranchMutation(race,adapter));
      assert.strictEqual(quarantined,true);
      assert.strictEqual(git(['rev-parse','refs/heads/fix/race']).trim(),targetHead);
      assert.strictEqual(runs,4);
      passed++;
    } finally { fs.rmSync(dir,{recursive:true,force:true}); fs.rmSync(hooks,{recursive:true,force:true}); }
  } catch(err) { failed++; console.error('Git branch mutation fixture regression:',err); }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-git-fence-'));
    try {
      let finishFails = false, acquires = 0;
      const inner: GitBranchAdapter = {
        async acquire() {
          acquires++;
          return {
            approvedTargets: [], emptyHooksDirectory: dir,
            async snapshot() { throw new Error('unused'); },
            async run() { throw new Error('unused'); },
            async finish() { if (finishFails) throw new Error('INNER_FINISH_FAILED'); }
          };
        }
      };
      const a = withDurableGitFence(dir,inner);
      const b = withDurableGitFence(dir,inner);
      const lease = await a.acquire('first');
      await assert.rejects(()=>b.acquire('alias'),/FENCE_HELD/);
      assert.strictEqual(acquires,1);
      await lease.finish('release');
      await assert.rejects(()=>lease.finish('release'),/LEASE_CLOSED/);
      const next = await b.acquire('alias');
      await next.finish('quarantine');
      await assert.rejects(()=>withDurableGitFence(dir,inner).acquire('first'),/FENCE_HELD/);
      const lock = path.join(dir,'git-mutation.lock');
      assert.ok(fs.existsSync(lock));
      fs.unlinkSync(lock); // fixture-only manual reconciliation
      finishFails = true;
      const bad = await a.acquire('first');
      await assert.rejects(()=>bad.finish('release'),/INNER_FINISH_FAILED/);
      await assert.rejects(()=>b.acquire('alias'),/FENCE_HELD/);
      fs.unlinkSync(lock);
      finishFails = false;
      const owner = await a.acquire('first');
      fs.writeFileSync(lock,'different owner');
      await assert.rejects(()=>owner.finish('release'),/OWNER_UNCERTAIN/);
      assert.strictEqual(fs.readFileSync(lock,'utf8'),'different owner');
      fs.unlinkSync(lock);
      const broken = withDurableGitFence(dir,{async acquire(){throw new Error('INNER_ACQUIRE_FAILED');}});
      await assert.rejects(()=>broken.acquire('first'),/INNER_ACQUIRE_FAILED/);
      await assert.rejects(()=>a.acquire('first'),/FENCE_HELD/);
      passed++;
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  } catch(err) { failed++; console.error('Git durable fence fixture regression:',err); }
  return {passed,failed};
}
