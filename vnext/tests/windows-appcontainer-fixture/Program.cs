using System.ComponentModel;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using static JobNative;
using static AppContainerNative;

// Hosted CI only. This fixture cannot launch an arbitrary requested command:
// executable is the CI Node binary, script is fixed, all ACL targets are a
// newly-created disposable directory, and the network destination is loopback.
internal static class Program {
    static void Require(bool ok, string message) {
        if (!ok) throw new InvalidOperationException(message);
    }
    static void Win(bool ok, string message) {
        if (!ok) {
            int err = Marshal.GetLastWin32Error();
            throw new Win32Exception(err, message + " (Win32=" + err + ")");
        }
    }
    static bool Valid(IntPtr h) => h != IntPtr.Zero && h != new IntPtr(-1);
    static string Q(string p) {
        Require(!p.Contains('"') && !p.EndsWith('\\'), "Unexpected fixture path");
        return "\"" + p + "\"";
    }
    static void NoReparse(string directory) {
        for (DirectoryInfo? d = new DirectoryInfo(directory); d != null; d = d.Parent)
            Require((d.Attributes & FileAttributes.ReparsePoint) == 0, "Reparse-point ancestor denied");
    }
    static void Protect(string dir, SecurityIdentifier owner, SecurityIdentifier package,
        FileSystemRights? rights, bool inherit) {
        Directory.CreateDirectory(dir);
        NoReparse(dir);
        var acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.SetOwner(owner);
        var all = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        foreach (var sid in new[]{owner,new SecurityIdentifier("S-1-5-18"),new SecurityIdentifier("S-1-5-32-544")})
            acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,all,PropagationFlags.None,AccessControlType.Allow));
        if (rights.HasValue) acl.AddAccessRule(new FileSystemAccessRule(package,rights.Value,
            inherit ? all : InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));
        new DirectoryInfo(dir).SetAccessControl(acl);
        var current = new DirectoryInfo(dir).GetAccessControl();
        Require(current.AreAccessRulesProtected && owner.Equals(current.GetOwner(typeof(SecurityIdentifier))), "Unexpected fixture directory ACL");
    }
    static void LowIntegrity(string work) {
        var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,"icacls.exe")) {
            UseShellExecute = false, CreateNoWindow = true
        };
        psi.ArgumentList.Add(work);
        psi.ArgumentList.Add("/setintegritylevel");
        psi.ArgumentList.Add("(OI)(CI)L");
        using var proc = Process.Start(psi) ?? throw new InvalidOperationException("icacls start");
        if (!proc.WaitForExit(15000)) {
            proc.Kill();
            Require(proc.WaitForExit(5000), "icacls exit unverified");
            throw new TimeoutException("icacls");
        }
        Require(proc.ExitCode == 0, "Low integrity fixture label failed");
    }
    static uint Active(IntPtr job) {
        Win(QueryInformationJobObject(job,1,out var info,(uint)Marshal.SizeOf<BasicAccounting>(),out _),"Query job");
        return info.ActiveProcesses;
    }
    static bool Drain(IntPtr job, IntPtr process, int ms) {
        var clock = Stopwatch.StartNew();
        do {
            if (Active(job)==0 && WaitForSingleObject(process,0)==WAIT_OBJECT_0) return true;
            Thread.Sleep(25);
        } while(clock.ElapsedMilliseconds<ms);
        return false;
    }
    static void Run(string root,string node,string script,IntPtr sid,int port,ref bool safeToRemove) {
        IntPtr job=IntPtr.Zero,nul=IntPtr.Zero,diagnostics=IntPtr.Zero,attrs=IntPtr.Zero,jobList=IntPtr.Zero,
            handles=IntPtr.Zero,caps=IntPtr.Zero,env=IntPtr.Zero;
        ProcessInfo pi=default;
        bool initialized=false, drained=false, created=false;
        try {
            job=CreateJobObjectW(IntPtr.Zero,null);
            Win(Valid(job),"Create job");
            var limit=new ExtendedLimit { BasicLimitInformation=new BasicLimit { LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } };
            Win(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf<ExtendedLimit>()),"Set job limit");
            var sa=new SecurityAttributes { nLength=(uint)Marshal.SizeOf<SecurityAttributes>(),bInheritHandle=true };
            nul=CreateFileW("NUL",0xc0000000,3,ref sa,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);
            Win(Valid(nul),"Open NUL");
            // Only the fixed synthetic probe writes this inherited stderr handle.
            // No control channel, credentials or arbitrary project output.
            string diagnosticPath=Path.Combine(root,"fixture-stderr.txt");
            diagnostics=CreateFileW(diagnosticPath,0x40000000,1,ref sa,1,FILE_ATTRIBUTE_NORMAL,IntPtr.Zero);
            Win(Valid(diagnostics),"Create fixture diagnostics");
            UIntPtr size=UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero,3,0,ref size);
            Require(size!=UIntPtr.Zero,"Missing attribute size");
            attrs=Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            Win(InitializeProcThreadAttributeList(attrs,3,0,ref size),"Init attributes");
            initialized=true;
            jobList=Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList,job);
            Win(UpdateProcThreadAttribute(attrs,0,JOB_LIST,jobList,(UIntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero),"Assign job at creation");
            handles=Marshal.AllocHGlobal(IntPtr.Size*2);
            Marshal.WriteIntPtr(handles,0,nul);
            Marshal.WriteIntPtr(handles,IntPtr.Size,diagnostics);
            Win(UpdateProcThreadAttribute(attrs,0,HANDLE_LIST,handles,(UIntPtr)(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero),"Allow only NUL and fixture diagnostics handles");
            var security=new SecurityCapabilities { AppContainerSid=sid,Capabilities=IntPtr.Zero,CapabilityCount=0,Reserved=0 };
            caps=Marshal.AllocHGlobal(Marshal.SizeOf<SecurityCapabilities>());
            Marshal.StructureToPtr(security,caps,false);
            Win(UpdateProcThreadAttribute(attrs,0,SecurityCapabilitiesAttribute,caps,(UIntPtr)Marshal.SizeOf<SecurityCapabilities>(),IntPtr.Zero,IntPtr.Zero),"Assign AppContainer");
            string work=Path.Combine(root,"work");
            string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string block=string.Join('\0',new[]{
                "APPDATA="+work,"LOCALAPPDATA="+work,"PATH="+Path.Combine(root,"tool"),
                "SystemRoot="+windows,"TEMP="+work,"TMP="+work,"USERPROFILE="+work,"WINDIR="+windows
            })+"\0\0";
            env=Marshal.StringToHGlobalUni(block);
            var startup=new StartupInfoEx {
                StartupInfo=new StartupInfo {cb=(uint)Marshal.SizeOf<StartupInfoEx>(),lpDesktop="",dwFlags=STARTF_USESTDHANDLES,hStdInput=nul,hStdOutput=nul,hStdError=diagnostics},
                lpAttributeList=attrs
            };
            var command=new StringBuilder(Q(node)+" "+Q(script)+" "+Q(root)+" "+port);
            Win(CreateProcessWithHandles(node,command,IntPtr.Zero,IntPtr.Zero,true,
                CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT|CreateUnicodeEnvironment|DetachedProcess,env,work,ref startup,out pi),"Create AppContainer fixture");
            created=true; safeToRemove=false;
            Win(IsProcessInJob(pi.hProcess,job,out var inJob),"Verify job");
            Require(inJob,"Child was not contained");
            VerifyZeroCapabilityToken(pi.hProcess,new SecurityIdentifier(sid).Value);
            Console.WriteLine("APPCONTAINER_KERNEL_TOKEN PASS (exact SID, zero capabilities, low integrity, Job membership)");
            Win(ResumeThread(pi.hThread)!=WAIT_FAILED,"Resume fixture");
            if (!Drain(job,pi.hProcess,30000)) throw new TimeoutException("Fixture job deadline");
            drained=true;safeToRemove=true;
            Win(GetExitCodeProcess(pi.hProcess,out var exit),"Get fixture exit");
            if(exit!=0) {
                Win(CloseHandle(diagnostics),"Close fixture diagnostics");
                diagnostics=IntPtr.Zero;
                using var stream=File.OpenRead(diagnosticPath);
                stream.Seek(Math.Max(0,stream.Length-4096),SeekOrigin.Begin);
                var buffer=new byte[4096];
                int n=stream.Read(buffer,0,buffer.Length);
                Console.Error.WriteLine("APPCONTAINER_PROBE_DIAGNOSTIC "+Encoding.UTF8.GetString(buffer,0,n));
                throw new InvalidOperationException("AppContainer probe exited with "+exit);
            }
        } finally {
            if (created && !drained && Valid(job)) {
                // Do not delete the profile or root while any process may live.
                try {
                    if (TerminateJobObject(job,124) && Drain(job,pi.hProcess,10000)) safeToRemove=true;
                } catch { safeToRemove=false; }
            }
            if(Valid(job))CloseHandle(job);
            if(initialized)DeleteProcThreadAttributeList(attrs);
            foreach(var p in new[]{attrs,jobList,handles,caps,env})if(p!=IntPtr.Zero)Marshal.FreeHGlobal(p);
            foreach(var h in new[]{nul,diagnostics,pi.hProcess,pi.hThread})if(Valid(h))CloseHandle(h);
        }
    }
    static int Main(string[] args) {
        if(!OperatingSystem.IsWindows()||Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||
           Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")
            throw new InvalidOperationException("Disposable GitHub-hosted Windows runner required.");
        Require(args.Length==1 && Path.IsPathFullyQualified(args[0]) &&
            Path.GetFileName(args[0]).Equals("node.exe",StringComparison.OrdinalIgnoreCase) && File.Exists(args[0]),"CI Node executable required");
        var owner=WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Missing owner SID");
        string root=Directory.CreateTempSubdirectory("dsu-ac-").FullName;
        string name="DevSpace.CI."+Guid.NewGuid().ToString("N");
        IntPtr sid=IntPtr.Zero;
        bool profileCreated=false,safeToRemove=true;
        var server=new TcpListener(IPAddress.Loopback,0);
        try {
            NoReparse(root);
            int hr=CreateAppContainerProfile(name,name,"Disposable security fixture",IntPtr.Zero,0,out sid);
            if(hr<0)Marshal.ThrowExceptionForHR(hr);
            profileCreated=true;Require(sid!=IntPtr.Zero,"Missing package SID");
            var package=new SecurityIdentifier(sid);
            Protect(root,owner,package,FileSystemRights.ReadAndExecute,false);
            foreach(var item in new[]{"protected","sibling","tool","work"}) {
                string dir=Path.Combine(root,item);
                Protect(dir,owner,package,item=="tool"?FileSystemRights.ReadAndExecute:item=="work"?FileSystemRights.Modify:null,true);
                if(item!="work")File.WriteAllText(Path.Combine(dir,"sentinel.txt"),"synthetic");
            }
            string work=Path.Combine(root,"work"),node=Path.Combine(root,"tool","node.exe"),script=Path.Combine(root,"tool","Probe.cjs");
            LowIntegrity(work);
            File.Copy(args[0],node);
            File.Copy(Path.Combine(AppContext.BaseDirectory,"Probe.cjs"),script);
            Environment.SetEnvironmentVariable("DSU_SYNTHETIC_PRIVATE_ENV","synthetic-only");
            server.Start();
            Run(root,node,script,sid,((IPEndPoint)server.LocalEndpoint).Port,ref safeToRemove);
            Require(!server.Pending(),"Loopback listener received a connection");
            using var report=JsonDocument.Parse(File.ReadAllText(Path.Combine(work,"report.json")));
            var checks=report.RootElement.GetProperty("checks").EnumerateArray().Select(x=>x.GetString()).ToArray();
            string[] expected={"environment-isolated","workspace-write-read","tool-read","tool-write","protected-read","protected-write","protected-delete","sibling-read","sibling-write","loopback-no-connect"};
            Require(checks.SequenceEqual(expected),"Missing or extra fixture checks");
            Require(report.RootElement.GetProperty("arch").GetString()==RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),"Wrong child architecture");
            foreach(var item in new[]{"protected","sibling","tool"})
                Require(File.ReadAllText(Path.Combine(root,item,"sentinel.txt"))=="synthetic","Protected sentinel changed");
            Require(File.ReadAllText(Path.Combine(work,"positive.txt"))=="approved","Approved output missing");
            Console.WriteLine("APPCONTAINER_OFFLINE_FIXTURE PASS (10 checks; "+RuntimeInformation.ProcessArchitecture+")");
            return 0;
        } finally {
            server.Stop();
            Environment.SetEnvironmentVariable("DSU_SYNTHETIC_PRIVATE_ENV",null);
            if(sid!=IntPtr.Zero)FreeSid(sid);
            if(!safeToRemove)throw new InvalidOperationException("Job drain uncertain; retain fixture root/profile for runner disposal.");
            if(profileCreated) {
                int hr=DeleteAppContainerProfile(name);
                if(hr<0)Marshal.ThrowExceptionForHR(hr);
            }
            Directory.Delete(root,true);
            Console.WriteLine("APPCONTAINER_FIXTURE_CLEANUP PASS");
        }
    }
}
