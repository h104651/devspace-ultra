import * as assert from 'assert';
import { planOfflineRunners } from '../../scripts/plan-offline-runners';

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
      const p=planOfflineRunners({tools,profiles:['node_version']});
      p.commands.test.node_version.args[0]='changed';
      assert.deepStrictEqual(planOfflineRunners({tools,profiles:['node_version']}).commands.test.node_version.args,['--version']);
    }
  ];
  for(const test of cases) {
    try { test(); passed++; }
    catch(err) { failed++; console.error('Offline runner planner regression:',err); }
  }
  return {passed,failed};
}
