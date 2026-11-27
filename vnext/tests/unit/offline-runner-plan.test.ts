import * as assert from 'assert';
import { planOfflineRunners, buildGitReadArgs } from '../../scripts/plan-offline-runners';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { TaskExecutor } from '../../src/local-agent/task-executor';

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
      passed++;
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  } catch(err) { failed++; console.error('Git offline execution gate regression:',err); }
  return {passed,failed};
}
