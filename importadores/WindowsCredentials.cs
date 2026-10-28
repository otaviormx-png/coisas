using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;

// Gerenciador de Credenciais do usuário Windows. Nunca grava senha em JSON, argumentos ou código.
public static class WindowsCredentials
{
    const uint Generic = 1, PersistLocalMachine = 2;
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)] static extern bool Write(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)] static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)] static extern bool Delete(string target,uint type,uint flags);

    static string Target(string mode,string dsn) {
        byte[] digest;
        using(var sha=SHA256.Create()) digest=sha.ComputeHash(Encoding.UTF8.GetBytes(mode+"\n"+dsn.Trim().ToUpperInvariant()));
        return "PEC_Importadores:"+mode+":"+BitConverter.ToString(digest).Replace("-","").ToLowerInvariant();
    }
    public static string ProvisioningFile(string mode,string dsn) {
        string key=Target(mode,dsn).Replace(":","_");
        return Path.Combine(Path.GetTempPath(),key+".setup.bin");
    }
    static bool ImportProvisioning(string mode,string dsn) {
        string file=ProvisioningFile(mode,dsn);
        if(!File.Exists(file)||new FileInfo(file).Length>65536)return false;
        if(File.GetLastWriteTimeUtc(file)<DateTime.UtcNow.AddDays(-7))return false;
        byte[] plain=null;
        try {
            plain=ProtectedData.Unprotect(File.ReadAllBytes(file),Encoding.UTF8.GetBytes("PEC_IMPORTADORES_ONE_TIME_V1"),DataProtectionScope.LocalMachine);
            var data=new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(Encoding.UTF8.GetString(plain));
            if(data["mode"]!=mode||Target(mode,data["dsn"])!=Target(mode,dsn))return false;
            Save(mode,dsn,data["user"],data["password"]);
            IntPtr check;
            if(!Read(Target(mode,dsn),Generic,0,out check))return false;
            try {
                var saved=(Credential)Marshal.PtrToStructure(check,typeof(Credential));
                string savedPassword=saved.CredentialBlobSize==0?"":Marshal.PtrToStringUni(saved.CredentialBlob,(int)saved.CredentialBlobSize/2);
                if(saved.UserName!=data["user"]||savedPassword!=data["password"])return false;
            } finally {CredFree(check);}
            data.Clear();File.Delete(file);return true;
        } catch {return false;}
        finally {if(plain!=null)Array.Clear(plain,0,plain.Length);}
    }
    public static void Save(string mode,string dsn,string user,string password) {
        if(String.IsNullOrWhiteSpace(dsn)||String.IsNullOrWhiteSpace(user))throw new ArgumentException("Informe banco e conta Firebird.");
        byte[] bytes=Encoding.Unicode.GetBytes(password);
        IntPtr secret=Marshal.AllocCoTaskMem(Math.Max(2,bytes.Length));
        try {
            if(bytes.Length>0)Marshal.Copy(bytes,0,secret,bytes.Length);
            var credential=new Credential { Type=Generic,TargetName=Target(mode,dsn),UserName=user,
                Comment="Login autorizado do importador PEC para o banco Firebird",CredentialBlob=secret,
                CredentialBlobSize=(uint)bytes.Length,Persist=PersistLocalMachine };
            if(!Write(ref credential,0))throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { if(bytes.Length>0)Marshal.Copy(new byte[bytes.Length],0,secret,bytes.Length);Marshal.FreeCoTaskMem(secret);Array.Clear(bytes,0,bytes.Length); }
    }
    public static bool TryLoad(string mode,string dsn,out string user,out string password) {
        user=password="";IntPtr buffer;
        if(!Read(Target(mode,dsn),Generic,0,out buffer)) {
            if(!ImportProvisioning(mode,dsn)||!Read(Target(mode,dsn),Generic,0,out buffer))return false;
        }
        try {
            var credential=(Credential)Marshal.PtrToStructure(buffer,typeof(Credential));
            user=credential.UserName??"";
            password=credential.CredentialBlobSize==0?"":Marshal.PtrToStringUni(credential.CredentialBlob,(int)credential.CredentialBlobSize/2);
            return user.Length>0;
        } finally {CredFree(buffer);}
    }
    public static void Forget(string mode,string dsn) {
        if(!Delete(Target(mode,dsn),Generic,0)&&Marshal.GetLastWin32Error()!=1168)throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
