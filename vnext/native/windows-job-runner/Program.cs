using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using static JobNative;

// Same-user containment candidate. NOT an OS identity sandbox, not installed by
// the service scripts, and never a remote shell. The caller supplies a resolved
// locally configured launch plan on a private stdin pipe; closing it cancels.
internal static class Program
{
    sealed record Plan(string Executable, string[] Args, string Cwd, bool Verbatim, int TimeoutMs);
    const int Failed = 1, Timeout = 124, Cancelled = 125, Rejected = 126, Uncertain = 127;
    static void Win(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static bool ValidHandle(IntPtr h) => h != IntPtr.Zero && h != new IntPtr(-1);
    static uint Active(IntPtr job) {
        Win(QueryInformationJobObject(job, 1, out var info, (uint)Marshal.SizeOf<BasicAccounting>(), out _), "QueryInformationJobObject");
        return info.ActiveProcesses;
    }
    static string ReadPlan() {
        var sb = new StringBuilder();
        while (sb.Length < 65536) {
            int ch = Console.In.Read();
            if (ch < 0) throw new InvalidDataException("Missing plan terminator");
            if (ch == '\n') return sb.ToString();
            sb.Append((char)ch);
        }
        throw new InvalidDataException("Plan exceeds maximum size");
    }
    static bool LocalPath(string s) => !string.IsNullOrEmpty(s) && s.Length >= 3 &&
        char.IsAsciiLetter(s[0]) && s[1] == ':' && (s[2] == '\\' || s[2] == '/') &&
        Path.IsPathFullyQualified(s) && !s.Contains('\0');
    static Plan ParsePlan() {
        var plan = JsonSerializer.Deserialize<Plan>(ReadPlan(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        if (plan == null || !LocalPath(plan.Executable) || !LocalPath(plan.Cwd) ||
            !File.Exists(plan.Executable) || !Directory.Exists(plan.Cwd) ||
            !Path.GetExtension(plan.Executable).Equals(".exe", StringComparison.OrdinalIgnoreCase) ||
            plan.Args == null || plan.Args.Length > 256 || plan.Args.Any(a => a == null || a.Contains('\0')) ||
            plan.TimeoutMs < 100 || plan.TimeoutMs > 7_200_000)
            throw new InvalidDataException("Invalid resolved launch plan");
        if (plan.Verbatim) {
            var systemCmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            if (!Path.GetFullPath(plan.Executable).Equals(systemCmd, StringComparison.OrdinalIgnoreCase) ||
                plan.Args.Length != 5 || plan.Args[0] != "/d" || plan.Args[1] != "/s" ||
                plan.Args[2] != "/v:off" || plan.Args[3] != "/c" ||
                !System.Text.RegularExpressions.Regex.IsMatch(plan.Args[4],
                    "^\"\"[A-Za-z]:[\\\\/][A-Za-z0-9_ .()~\\\\/-]+\\.(?:cmd|bat)\"(?: \"[A-Za-z0-9_ .:\\\\/=-]+\")*\"$",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant))
                throw new InvalidDataException("Invalid fixed wrapper plan");
        }
        return plan;
    }
    // Windows CRT argument escaping, including trailing backslashes and quotes.
    static string Quote(string arg) {
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') sb.Append('\\', slashes * 2 + 1);
            else sb.Append('\\', slashes);
            sb.Append(c);
            slashes = 0;
        }
        sb.Append('\\', slashes * 2);
        return sb.Append('"').ToString();
    }
    static IntPtr InheritOutput(int id) {
        var original = GetStdHandle(id);
        Win(ValidHandle(original), "GetStdHandle");
        var self = GetCurrentProcess();
        Win(DuplicateHandle(self, original, self, out var dup, 0, true, DUPLICATE_SAME_ACCESS), "DuplicateHandle");
        return dup;
    }
    static bool Drain(IntPtr job, IntPtr root) {
        var until = Stopwatch.StartNew();
        while (until.ElapsedMilliseconds < 10000) {
            if (Active(job) == 0 && WaitForSingleObject(root, 0) == WAIT_OBJECT_0) return true;
            Thread.Sleep(20);
        }
        return Active(job) == 0 && WaitForSingleObject(root, 0) == WAIT_OBJECT_0;
    }
    static int Run(Plan plan, Task<int> cancel) {
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        IntPtr attrs = IntPtr.Zero, handles = IntPtr.Zero, jobHandles = IntPtr.Zero;
        bool attrsInitialized = false, assigned = false, resumed = false;
        ProcessInfo pi = default;
        try {
            if (cancel.IsCompleted) return Cancelled;
            job = CreateJobObjectW(IntPtr.Zero, null);
            Win(ValidHandle(job), "CreateJobObject");
            var limit = new ExtendedLimit {
                BasicLimitInformation = new BasicLimit { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE }
            };
            Win(SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf<ExtendedLimit>()), "SetInformationJobObject");
            var sa = new SecurityAttributes { nLength = (uint)Marshal.SizeOf<SecurityAttributes>(), bInheritHandle = true };
            input = CreateFileW("NUL", GENERIC_READ, 3, ref sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            Win(ValidHandle(input), "Open NUL");
            output = InheritOutput(-11);
            error = InheritOutput(-12);
            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            Win(size != UIntPtr.Zero, "Attribute list size");
            attrs = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            Win(InitializeProcThreadAttributeList(attrs, 2, 0, ref size), "Initialize attribute list");
            attrsInitialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, input);
            Marshal.WriteIntPtr(handles, IntPtr.Size, output);
            Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
            Win(UpdateProcThreadAttribute(attrs, 0, HANDLE_LIST, handles, (UIntPtr)(IntPtr.Size * 3),
                IntPtr.Zero, IntPtr.Zero), "Set inherited handle allowlist");
            // Windows 10+ supports creation-time job assignment. Keep the
            // attribute backing memory alive until deleting the attribute list.
            // No separate uncontained launch/assign sequence and no fallback.
            jobHandles = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobHandles, job);
            Win(UpdateProcThreadAttribute(attrs, 0, JOB_LIST, jobHandles, (UIntPtr)IntPtr.Size,
                IntPtr.Zero, IntPtr.Zero), "Set creation-time job list");
            var startup = new StartupInfoEx {
                StartupInfo = new StartupInfo {
                    cb = (uint)Marshal.SizeOf<StartupInfoEx>(), dwFlags = STARTF_USESTDHANDLES,
                    hStdInput = input, hStdOutput = output, hStdError = error
                },
                lpAttributeList = attrs
            };
            var command = new StringBuilder(Quote(plan.Executable));
            foreach (var arg in plan.Args) command.Append(' ').Append(plan.Verbatim ? arg : Quote(arg));
            if (command.Length >= 32767) throw new InvalidDataException("Command line exceeds Windows limit");
            Win(CreateProcessWithHandles(plan.Executable, command, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                IntPtr.Zero, plan.Cwd, ref startup, out pi), "Create suspended runner");
            // The process was created with JOB_LIST and is still suspended.
            // Verify membership before any runner instruction is allowed.
            Win(IsProcessInJob(pi.hProcess, job, out var inJob), "Verify created process job membership");
            if (!inJob) throw new InvalidOperationException("Created runner is outside its job");
            assigned = true;
            if (cancel.IsCompleted) {
                Win(TerminateJobObject(job, Cancelled), "Cancel before resume");
                return Drain(job, pi.hProcess) ? Cancelled : Uncertain;
            }
            Win(ResumeThread(pi.hThread) != WAIT_FAILED, "Resume runner");
            resumed = true;
            var elapsed = Stopwatch.StartNew();
            while (Active(job) != 0) {
                int reason = cancel.IsCompleted ? Cancelled : elapsed.ElapsedMilliseconds >= plan.TimeoutMs ? Timeout : 0;
                if (reason != 0) {
                    Win(TerminateJobObject(job, (uint)reason), "Terminate runner job");
                    return Drain(job, pi.hProcess) ? reason : Uncertain;
                }
                Thread.Sleep(20);
            }
            if (!Drain(job, pi.hProcess)) return Uncertain;
            Win(GetExitCodeProcess(pi.hProcess, out var exit), "Get runner exit");
            return exit == 0 ? 0 : Failed;
        } catch (Exception ex) {
            // Never print command arguments or the inherited environment.
            Console.Error.WriteLine("Job runner setup/control failure: " + ex.GetType().Name);
            try {
                if (assigned) {
                    if (!TerminateJobObject(job, Rejected) || !Drain(job, pi.hProcess)) return Uncertain;
                    return resumed ? Failed : Rejected;
                }
                if (ValidHandle(pi.hProcess)) {
                    if (!TerminateProcess(pi.hProcess, Rejected) ||
                        WaitForSingleObject(pi.hProcess, 5000) != WAIT_OBJECT_0) return Uncertain;
                }
                return Rejected;
            } catch { return Uncertain; }
        } finally {
            // No breakaway flag; job close is the final OS cleanup safeguard.
            if (ValidHandle(job)) CloseHandle(job);
            if (attrsInitialized) DeleteProcThreadAttributeList(attrs);
            if (attrs != IntPtr.Zero) Marshal.FreeHGlobal(attrs);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobHandles != IntPtr.Zero) Marshal.FreeHGlobal(jobHandles);
            foreach (var h in new[] { input, output, error, pi.hProcess, pi.hThread })
                if (ValidHandle(h)) CloseHandle(h);
        }
    }
    static int Main(string[] args) {
        if (!OperatingSystem.IsWindows() || args.Length != 0 ||
            !Console.IsInputRedirected || !Console.IsOutputRedirected || !Console.IsErrorRedirected)
            return Rejected;
        try {
            var plan = ParsePlan();
            // No target process inherits stdin. EOF (including caller death)
            // or any additional byte is cancellation, not a second command.
            var cancel = Task.Run(() => Console.In.Read());
            return Run(plan, cancel);
        } catch (Exception ex) {
            Console.Error.WriteLine("Job runner rejected plan: " + ex.GetType().Name);
            return Rejected;
        }
    }
}
