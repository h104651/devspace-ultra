using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using static JobNative;

// Native primitives only. No production admission, ACL mutation or profile
// activation occurs from this class by itself.
internal static class AppContainerNative {
    internal static readonly IntPtr SecurityCapabilitiesAttribute = new(0x00020009);
    internal const uint CreateUnicodeEnvironment = 0x00000400;
    internal const uint DetachedProcess = 0x00000008;
    [StructLayout(LayoutKind.Sequential)]
    internal struct SecurityCapabilities {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern int CreateAppContainerProfile(string name, string displayName, string description,
        IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")]
    internal static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, uint length, out uint required);
    static T ReadToken<T>(IntPtr token, int infoClass, Func<IntPtr,T> read) {
        GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out uint size);
        int error = Marshal.GetLastWin32Error();
        if (error != 122 || size == 0 || size > 65536)
            throw new Win32Exception(error, "Unexpected token information length");
        var buffer = Marshal.AllocHGlobal((int)size);
        try {
            if (!GetTokenInformation(token, infoClass, buffer, size, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation");
            return read(buffer);
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static void VerifyZeroCapabilityToken(IntPtr process, string expectedSid) {
        if (!OpenProcessToken(process, 8, out var token))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken");
        try {
            // TOKEN_INFORMATION_CLASS: TokenIntegrityLevel=25,
            // TokenIsAppContainer=29, TokenCapabilities=30, TokenAppContainerSid=31.
            var isContainer = ReadToken(token, 29, p => Marshal.ReadInt32(p));
            var sid = ReadToken(token, 31, p => new SecurityIdentifier(Marshal.ReadIntPtr(p)).Value);
            var count = ReadToken(token, 30, p => Marshal.ReadInt32(p));
            var integrity = ReadToken(token, 25, p => new SecurityIdentifier(Marshal.ReadIntPtr(p)).Value);
            if (isContainer != 1 || sid != expectedSid || count != 0 || integrity != "S-1-16-4096")
                throw new InvalidOperationException("Unexpected AppContainer SID, capability count or integrity.");
        } finally { CloseHandle(token); }
    }
}
