using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// Synthetic peer-authentication fixture. Fixed handshake only; no commands,
// filesystem paths, credentials, privileged operations or production endpoint.
public static class PipeBoundaryFixture {
    const uint Duplex = 3, FirstInstance = 0x00080000, Overlapped = 0x40000000;
    const uint RejectRemote = 8, OpenExisting = 3;
    // Explicit per-rights pipe mask; do not grant generic write.
    // Includes data, EA, attributes, READ_CONTROL and SYNCHRONIZE; excludes create-instance.
    const uint ClientAccess = 0x0012019b;
    const uint Identification = 0x00110000; // SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION
    const int AccessDenied = 5;
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision,
        out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafePipeHandle CreateNamedPipeW(string name, uint mode, uint pipeMode, uint instances,
        uint output, uint input, uint timeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafePipeHandle CreateFileW(string name, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(SafePipeHandle handle, int objectType, uint securityInfo,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetNamedPipeServerProcessId(SafePipeHandle handle, out uint pid);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);

    static string PathFor(string name) {
        if (name == null || !System.Text.RegularExpressions.Regex.IsMatch(name, "^dsu-ci-[a-f0-9]{32}$"))
            throw new InvalidDataException("Not a synthetic pipe name.");
        return @"\\.\pipe\" + name;
    }
    static void Require(bool condition, string message) {
        if (!condition) throw new InvalidOperationException(message);
    }
    static void Win(bool condition, string operation) {
        if (!condition) {
            int code = Marshal.GetLastWin32Error();
            throw new Win32Exception(code, operation + " (Win32=" + code + ")");
        }
    }
    static SafePipeHandle Open(string name) {
        return CreateFileW(PathFor(name), ClientAccess, 0, IntPtr.Zero, OpenExisting, Identification, IntPtr.Zero);
    }
    static string Owner(SafePipeHandle handle) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint code = GetSecurityInfo(handle, 6, 1, out owner, out group, out dacl, out sacl, out descriptor);
        if (code != 0) throw new Win32Exception((int)code, "GetSecurityInfo pipe owner");
        try { return new SecurityIdentifier(owner).Value; }
        finally { LocalFree(descriptor); }
    }
    public static NamedPipeServerStream CreateServer(string name, string supervisorSid, string agentSid) {
        // Only the supervisor can create new instances or change the descriptor.
        // Generic write is deliberately not granted to the Agent.
        string owner = new SecurityIdentifier(supervisorSid).Value;
        string agent = new SecurityIdentifier(agentSid).Value;
        Require(owner != agent, "Supervisor and Agent must differ.");
        string sddl = "O:" + owner + "D:P(A;;FA;;;SY)(A;;FA;;;" + owner + ")(A;;0x0012019b;;;" + agent + ")";
        IntPtr sd;
        uint size;
        Win(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size), "Convert SDDL");
        try {
            var sa = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = sd, Inherit = false };
            SafePipeHandle handle = CreateNamedPipeW(PathFor(name), Duplex | FirstInstance | Overlapped,
                RejectRemote, 4, 4096, 4096, 0, ref sa);
            if (handle.IsInvalid) {
                int err = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(err, "Create first pipe instance");
            }
            try {
                Require(Owner(handle) == owner, "Supervisor pipe owner mismatch.");
                return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
            } catch { handle.Dispose(); throw; }
        } finally { LocalFree(sd); }
    }
    public static void RequireOpenDenied(string name) {
        using (SafePipeHandle handle = Open(name)) {
            int err = Marshal.GetLastWin32Error();
            Require(handle.IsInvalid && err == AccessDenied, "Unapproved pipe open was not ACL-denied; error=" + err);
        }
    }
    public static void RequireCreateInstanceDenied(string name) {
        var sa = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = false };
        // No FIRST_INSTANCE flag: test the ACL, not name-collision behavior.
        using (SafePipeHandle handle = CreateNamedPipeW(PathFor(name), Duplex, RejectRemote, 4, 4096, 4096, 0, ref sa)) {
            int err = Marshal.GetLastWin32Error();
            Require(handle.IsInvalid && err == AccessDenied, "Unapproved pipe instance creation was not ACL-denied; error=" + err);
        }
    }
    static async Task ReadExactAsync(Stream stream, byte[] buffer, CancellationToken token) {
        int offset = 0;
        while (offset < buffer.Length) {
            int n = await stream.ReadAsync(buffer, offset, buffer.Length - offset, token).ConfigureAwait(false);
            Require(n > 0, "Unexpected fixture EOF.");
            offset += n;
        }
    }
    public static async Task<string> AcceptAsync(NamedPipeServerStream pipe, string expectedAgentSid) {
        using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(50))) {
            await pipe.WaitForConnectionAsync(timeout.Token).ConfigureAwait(false);
            byte[] request = new byte[4];
            await ReadExactAsync(pipe, request, timeout.Token).ConfigureAwait(false);
            string sid = null;
            // Query the peer's actual identification token. No work as peer.
            pipe.RunAsClient(delegate {
                using (var identity = WindowsIdentity.GetCurrent(true)) {
                    Require(identity != null && identity.User != null, "No authenticated peer token.");
                    sid = identity.User.Value;
                }
            });
            Require(sid == expectedAgentSid, "Unexpected client identity.");
            Require(System.Text.Encoding.ASCII.GetString(request) == "DSU1", "Unknown synthetic request.");
            byte[] response = System.Text.Encoding.ASCII.GetBytes("OKAY");
            await pipe.WriteAsync(response, 0, response.Length, timeout.Token).ConfigureAwait(false);
            await pipe.FlushAsync(timeout.Token).ConfigureAwait(false);
            return sid;
        }
    }
    public static void RoundTrip(string name, string expectedOwnerSid, uint expectedServerPid) {
        using (SafePipeHandle handle = Open(name)) {
            Win(!handle.IsInvalid, "Open allowed pipe");
            // Owner and PID are expected from the protected test supervisor,
            // never accepted from bytes supplied by the peer.
            Require(Owner(handle) == expectedOwnerSid, "Untrusted server owner.");
            uint actualPid;
            Win(GetNamedPipeServerProcessId(handle, out actualPid), "GetNamedPipeServerProcessId");
            Require(actualPid == expectedServerPid, "Untrusted server process.");
            using (var pipe = new NamedPipeClientStream(PipeDirection.InOut, false, true, handle)) {
                byte[] request = System.Text.Encoding.ASCII.GetBytes("DSU1");
                pipe.Write(request, 0, request.Length);
                pipe.Flush();
                byte[] response = new byte[4];
                int offset = 0;
                while (offset < response.Length) {
                    int n = pipe.Read(response, offset, response.Length - offset);
                    Require(n > 0, "Unexpected fixture EOF.");
                    offset += n;
                }
                Require(System.Text.Encoding.ASCII.GetString(response) == "OKAY", "Bad synthetic response.");
            }
        }
    }
}
