# Offline toolchain profile planner (DRAFT)

This local planner generates the existing project `commands.test/build` structure. It does not execute a tool, scan a machine, discover credentials, edit projects.json, grant a Windows SID, modify ACLs, grant an OAuth scope or authorize activation.

Run locally from vnext with an already-installed ts-node: `npx --no-install ts-node scripts/plan-offline-runners.ts <local-plan.json>`. The input must explicitly select profiles, staged absolute Windows paths, and an optional normalized project-relative working directory. Example:

```json
{
  "tools": {
    "flutter": "C:\\StagedTools\\flutter\\bin\\flutter.bat",
    "dart": "C:\\StagedTools\\flutter\\bin\\dart.bat"
  },
  "profiles": ["flutter_analyze", "flutter_test", "flutter_build_apk_debug"],
  "workingRelativePath": "app/mobile"
}
```

| Category | Fixed candidate IDs |
|---|---|
| Flutter | flutter_analyze, flutter_test, flutter_build_apk_debug, flutter_pub_get_offline |
| Dart | dart_analyze, dart_test, dart_format_check |
| Android | gradle_test, gradle_assemble_debug, java_version, adb_version |
| Node.js | node_version, npm_test, npm_build, npm_ci_offline |
| Python | python_version, python_pytest |

Dependency-changing profiles require explicit `allowDependencyMutation: true` in local planner input. This is a planning gate, not runtime authorization. Existing Build/Test scopes, per-project permissions, local runner policy and production runtime hold still apply. npm explicit test/build scripts execute project code even with --ignore-scripts (which suppresses lifecycle hooks for these commands); dependencies may still execute code. Gradle plugins, Python tests and Flutter projects also execute code. Network and protected file access must be constrained by the OS identity rather than by command names.

The current AppContainer candidate uses a deliberately minimal environment, no inherited profile or caches, and does not yet provide a staged multi-tool PATH or isolated SDK/cache configuration. These profiles are not claimed runnable on either workstation. Their tool paths must be independently verified and protected from workspace replacement; offline dependency caches, wrapper distributions, Android SDK licenses and actual native toolchain architecture/compatibility need proof. In particular Gradle wrapper and Flutter may require staged auxiliary executables and writable caches. Do not grant access to drive roots, host profile or signing credentials to fix compatibility.

Not enabled: release APK/AAB signing, publication, dependency network downloads, Python installation, ADB device install/shell, Git network/mutation or arbitrary commands. These need distinct explicit policies and tests. Git read/diff/log should use its own bounded read capability rather than pretending to be Build/Test. No production CLI flag is introduced.

## Git committed-history profiles (interim)
The planner now supports `git_log` and `git_diff_commits`, with explicit per-profile `gitSelections` containing full object IDs and a bounded log count. These fixed queries use a direct staged `.git` directory, committed objects only, no external diff/textconv/signature/notes/replace refs, and no protocol access. The native offline environment disables global/system Git config, lazy fetch, optional locks and terminal prompts. The reserved test runner IDs require the configured Windows AppContainer path. No remote argument, branch expression, working-tree diff, Git mutation or credential handling. Real disposable Git repository tests verify the generated vectors and dirty-worktree preservation. This interim path uses the existing test execution scope and locally approved profiles, not the final independent Git read MCP API. Repository-local config/object alternates and staged toolchain integrity still require isolation/provisioning review; the command switches are not a standalone sandbox. Native Git staging compatibility remains unverified. Do not enable production execution on this basis.
