using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Isolated test fixture only. This executable is NOT an Agent runner or a
// general command broker. It launches only its own synthetic worker modes.
internal static class Program
{
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint SYNCHRONIZE = 0x00100000;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;
    const uint WAIT_FAILED = 0xffffffff;

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit {
        public BasicLimit BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicAccounting {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public uint cb;
        public string? lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out BasicAccounting info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CreateProcessW(string app, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, string? cwd,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CloseHandle(IntPtr handle);

    static void Require(bool condition, string message) {
        if (!condition) throw new InvalidOperationException(message);
    }
    static void Win(bool condition, string operation) {
        if (!condition) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static string Self => Environment.ProcessPath ?? throw new InvalidOperationException("No apphost path.");
    static uint Active(IntPtr job) {
        Win(QueryInformationJobObject(job, 1, out var info, (uint)Marshal.SizeOf<BasicAccounting>(), out _), "QueryInformationJobObject");
        return info.ActiveProcesses;
    }

    static void Scenario(string root, bool closeInsteadOfTerminate) {
        string marker = Path.Combine(root, closeInsteadOfTerminate ? "close-child.pid" : "timeout-child.pid");
        IntPtr job = IntPtr.Zero, child = IntPtr.Zero;
        ProcessInfo pi = default;
        bool assigned = false;
        try {
            job = CreateJobObjectW(IntPtr.Zero, null);
            Win(job != IntPtr.Zero, "CreateJobObject");
            var limit = new ExtendedLimit {
                BasicLimitInformation = new BasicLimit { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE }
            };
            Win(SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf<ExtendedLimit>()), "SetInformationJobObject");
            var si = new StartupInfo { cb = (uint)Marshal.SizeOf<StartupInfo>() };
            // Both paths are generated locally, not supplied by any task/caller.
            var command = new StringBuilder($"\"{Self}\" --fixture-parent \"{marker}\"");
            Win(CreateProcessW(Self, command, IntPtr.Zero, IntPtr.Zero, false,
                CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, root, ref si, out pi), "CreateProcess suspended");
            Win(AssignProcessToJobObject(job, pi.hProcess), "AssignProcessToJobObject");
            assigned = true;
            Require(ResumeThread(pi.hThread) != WAIT_FAILED, "ResumeThread failed");
            var ready = Stopwatch.StartNew();
            uint childPid = 0;
            while (ready.Elapsed < TimeSpan.FromSeconds(15)) {
                try {
                    if (File.Exists(marker) && uint.TryParse(File.ReadAllText(marker), out childPid) && childPid != 0) break;
                } catch (IOException) {}
                Thread.Sleep(25);
            }
            Require(childPid != 0, "Fixture child never became ready");
            child = OpenProcess(SYNCHRONIZE, false, childPid);
            Win(child != IntPtr.Zero, "Open fixture child synchronization handle");
            Require(WaitForSingleObject(child, 0) == WAIT_TIMEOUT, "Child must be alive before cancellation");
            Require(Active(job) >= 2, "Both parent and child must be assigned to the job");
            Require(WaitForSingleObject(pi.hProcess, 100) == WAIT_TIMEOUT, "Parent must exceed the fixture deadline");
            if (closeInsteadOfTerminate) {
                Win(CloseHandle(job), "Close job with KILL_ON_JOB_CLOSE");
                job = IntPtr.Zero;
            } else {
                Win(TerminateJobObject(job, 124), "Terminate timed-out job");
            }
            Require(WaitForSingleObject(pi.hProcess, 5000) == WAIT_OBJECT_0, "Parent did not exit");
            Require(WaitForSingleObject(child, 5000) == WAIT_OBJECT_0, "Child did not exit");
            if (job != IntPtr.Zero) {
                var drained = Stopwatch.StartNew();
                while (Active(job) != 0 && drained.Elapsed < TimeSpan.FromSeconds(5)) Thread.Sleep(20);
                Require(Active(job) == 0, "Job still contains active processes");
            }
            Console.WriteLine(closeInsteadOfTerminate ? "KILL_ON_CLOSE PASS" : "TIMEOUT_TREE_TERMINATION PASS");
        } finally {
            // If assigning the suspended child failed, terminate only our own
            // newly created process using its handle; never kill by name/PID.
            if (!assigned && pi.hProcess != IntPtr.Zero) TerminateProcess(pi.hProcess, 125);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (pi.hProcess != IntPtr.Zero) {
                WaitForSingleObject(pi.hProcess, 5000);
                CloseHandle(pi.hProcess);
            }
            if (child != IntPtr.Zero) {
                WaitForSingleObject(child, 5000);
                CloseHandle(child);
            }
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
        }
    }

    static int Main(string[] args) {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (args.Length == 2 && args[0] == "--fixture-parent") {
            var psi = new ProcessStartInfo(Self) { UseShellExecute = false, CreateNoWindow = true };
            psi.ArgumentList.Add("--fixture-child");
            psi.ArgumentList.Add(args[1]);
            using var child = Process.Start(psi) ?? throw new InvalidOperationException("Fixture child start failed");
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }
        if (args.Length == 2 && args[0] == "--fixture-child") {
            File.WriteAllText(args[1], Environment.ProcessId.ToString());
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }
        Require(args.Length == 0, "Fixture accepts no external command");
        Require(Path.GetFileName(Self).Equals("WindowsJobFixture.exe", StringComparison.OrdinalIgnoreCase), "Run compiled apphost, not dotnet host");
        var root = Path.Combine(Path.GetTempPath(), "dsu-job-fixture-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            Scenario(root, false);
            Scenario(root, true);
            Console.WriteLine($"Native Job Object fixture PASS; architecture={RuntimeInformation.ProcessArchitecture}");
            return 0;
        } finally { Directory.Delete(root, true); }
    }
}
