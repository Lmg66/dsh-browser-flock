param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference='Stop'
$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))|ConvertFrom-Json
function Assert-SafePath([string]$target){
 $cursor=$target
 while($cursor){if(Test-Path -LiteralPath $cursor){$entry=Get-Item -LiteralPath $cursor -Force;if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse point refused in window identity files'}};$parent=Split-Path -Parent $cursor;if($parent -eq $cursor){break};$cursor=$parent}
}
Assert-SafePath $v.statusPath
@{status='initializing';pid=$PID}|ConvertTo-Json -Compress|Set-Content -LiteralPath $v.statusPath -Encoding UTF8
$hostProcess=Get-Process -Id ([int]$v.hostPid)
$hostStart=$hostProcess.StartTime.ToUniversalTime().ToString('o');$hostExecutable=$hostProcess.Path
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class FlockWindowIdentity {
 [StructLayout(LayoutKind.Sequential,Pack=4)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; public PROPERTYKEY(uint p){fmtid=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");pid=p;} }
 [StructLayout(LayoutKind.Explicit,Size=24)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr ptr; }
 [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IPropertyStore {
  [PreserveSig] int GetCount(out uint c); [PreserveSig] int GetAt(uint i,out PROPERTYKEY k); [PreserveSig] int GetValue(ref PROPERTYKEY k,out PROPVARIANT v); [PreserveSig] int SetValue(ref PROPERTYKEY k,ref PROPVARIANT v); [PreserveSig] int Commit();
 }
 delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr p);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr h,string file,uint type,int x,int y,uint flags);
 [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h,uint msg,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
 [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h,ref Guid iid,[MarshalAs(UnmanagedType.Interface)]out IPropertyStore store);
 [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);
 public static bool Alive(int pid,string executable,string startTime){try{using(var p=Process.GetProcessById(pid)){return String.Equals(p.MainModule.FileName,executable,StringComparison.OrdinalIgnoreCase)&&Math.Abs((p.StartTime.ToUniversalTime()-DateTime.Parse(startTime).ToUniversalTime()).TotalMilliseconds)<1;}}catch{return false;}}
 public static IntPtr Icon(string file,int size){var h=LoadImage(IntPtr.Zero,file,1,size,size,0x10);if(h==IntPtr.Zero)throw new Exception("LoadImage failed");return h;}
 public static long[] Windows(int pid){var list=new List<long>();EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);if(id==pid&&IsWindowVisible(h))list.Add(h.ToInt64());return true;},IntPtr.Zero);return list.ToArray();}
 static string Property(IntPtr hwnd,uint id,string value){Guid iid=typeof(IPropertyStore).GUID;IPropertyStore store;Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(hwnd,ref iid,out store));try {var key=new PROPERTYKEY(id);PROPVARIANT pv;if(value!=null){pv=value=="\u0001"?new PROPVARIANT():new PROPVARIANT{vt=31,ptr=Marshal.StringToCoTaskMemUni(value)};try{Marshal.ThrowExceptionForHR(store.SetValue(ref key,ref pv));Marshal.ThrowExceptionForHR(store.Commit());}finally{PropVariantClear(ref pv);}}Marshal.ThrowExceptionForHR(store.GetValue(ref key,out pv));try{return pv.vt==31?Marshal.PtrToStringUni(pv.ptr):null;}finally{PropVariantClear(ref pv);}}finally{Marshal.ReleaseComObject(store);}}
 public static string[] Apply(long handle,int pid,string executable,string startTime,string appId,string iconPath,IntPtr big,IntPtr small){
  var hwnd=new IntPtr(handle);uint current;GetWindowThreadProcessId(hwnd,out current);if(current!=pid)throw new Exception("Window owner changed");
  using(var p=Process.GetProcessById(pid)){if(!String.Equals(p.MainModule.FileName,executable,StringComparison.OrdinalIgnoreCase)||Math.Abs((p.StartTime.ToUniversalTime()-DateTime.Parse(startTime).ToUniversalTime()).TotalMilliseconds)>=1)throw new Exception("Process identity changed");}
  Property(hwnd,5,appId);Property(hwnd,3,iconPath);
  IntPtr result;if(SendMessageTimeout(hwnd,0x80,new IntPtr(1),big,2,500,out result)==IntPtr.Zero)throw new Exception("Window did not accept big icon");
  if(SendMessageTimeout(hwnd,0x80,IntPtr.Zero,small,2,500,out result)==IntPtr.Zero)throw new Exception("Window did not accept small icon");
  return Read(handle);
 }
 public static string[] Read(long handle){var hwnd=new IntPtr(handle);IntPtr big,small;SendMessageTimeout(hwnd,0x7f,new IntPtr(1),IntPtr.Zero,2,500,out big);SendMessageTimeout(hwnd,0x7f,IntPtr.Zero,IntPtr.Zero,2,500,out small);return new string[]{Property(hwnd,5,null),Property(hwnd,3,null),big.ToInt64().ToString(),small.ToInt64().ToString()};}
}
'@
$big=[IntPtr]::Zero;$small=[IntPtr]::Zero;$original=@{}
function Save-Status($data){Assert-SafePath $v.statusPath;$data.requestId=$v.requestId;$data|ConvertTo-Json -Depth 6 -Compress|Set-Content -LiteralPath $v.statusPath -Encoding UTF8}
function Owned-Process {
 $c=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$v.pid)
 if(!$c){return $false}
 return ($c.CreationDate.ToUniversalTime().ToString('o') -eq $v.startTime -and $c.ExecutablePath -eq $v.executablePath -and $c.CommandLine -ceq $v.commandLine)
}
try {
 if(!(Owned-Process)){throw 'Process identity could not be verified'}
 if($v.readOnly){$items=@();foreach($handle in [FlockWindowIdentity]::Windows([int]$v.pid)){$items+=@{hwnd=$handle;values=[FlockWindowIdentity]::Read($handle)}};Save-Status @{status='read';windows=$items};exit}
 # The caller validates Repository profile ownership; create only this instance's icon.
 $bmp=New-Object Drawing.Bitmap 64,64
 $g=[Drawing.Graphics]::FromImage($bmp)
 try {
  $g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([Drawing.Color]::Transparent)
  # Keep the verified browser executable's original artwork as the primary icon.
  $browserIcon=[Drawing.Icon]::ExtractAssociatedIcon($v.executablePath)
  if(!$browserIcon){throw 'Browser executable icon could not be extracted'}
  try {$g.DrawIcon($browserIcon,([Drawing.Rectangle]::new(0,0,64,64)))}finally{$browserIcon.Dispose()}
  $brush=New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($v.color))
  $g.FillEllipse([Drawing.Brushes]::White,35,0,29,29)
  $g.FillEllipse($brush,37,2,25,25);$brush.Dispose()
  $font=New-Object Drawing.Font 'Segoe UI',20,([Drawing.FontStyle]::Bold),([Drawing.GraphicsUnit]::Pixel)
  $format=New-Object Drawing.StringFormat;$format.Alignment='Center';$format.LineAlignment='Center'
  $g.DrawString([string]$v.label,$font,[Drawing.Brushes]::White,([Drawing.RectangleF]::new(37,1,25,25)),$format)
  $font.Dispose();$format.Dispose()
  # PNG-backed ICO preserves full alpha rather than a legacy monochrome icon mask.
  $png=[IO.MemoryStream]::new()
  try {
   $bmp.Save($png,[Drawing.Imaging.ImageFormat]::Png);$bytes=$png.ToArray()
   Assert-SafePath $v.iconPath;$stream=[IO.File]::Open($v.iconPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
   $writer=[IO.BinaryWriter]::new($stream)
   try {$writer.Write([uint16]0);$writer.Write([uint16]1);$writer.Write([uint16]1);$writer.Write([byte]64);$writer.Write([byte]64);$writer.Write([byte]0);$writer.Write([byte]0);$writer.Write([uint16]1);$writer.Write([uint16]32);$writer.Write([uint32]$bytes.Length);$writer.Write([uint32]22);$writer.Write($bytes)}finally{$writer.Dispose();$stream.Dispose()}
  } finally {$png.Dispose()}
 } finally {$g.Dispose();$bmp.Dispose()}
 $big=[FlockWindowIdentity]::Icon($v.iconPath,32);$small=[FlockWindowIdentity]::Icon($v.iconPath,16)
 while([FlockWindowIdentity]::Alive([int]$v.pid,$v.executablePath,$v.startTime) -and [FlockWindowIdentity]::Alive([int]$v.hostPid,$hostExecutable,$hostStart) -and !(Test-Path -LiteralPath $v.stopPath)){
  $items=@()
  foreach($handle in [FlockWindowIdentity]::Windows([int]$v.pid)){
   $values=[FlockWindowIdentity]::Read($handle)
   if($values[0] -ne $v.appId -or $values[1] -ne $v.iconPath -or $values[2] -ne $big.ToInt64().ToString() -or $values[3] -ne $small.ToInt64().ToString()){
    if(!(Owned-Process)){throw 'Process identity changed before window mutation'}
    if(!$original.ContainsKey($handle)){$original[$handle]=$values}
    $values=[FlockWindowIdentity]::Apply($handle,[int]$v.pid,$v.executablePath,$v.startTime,$v.appId,$v.iconPath,$big,$small)
   }
   $items+=@{hwnd=$handle;appId=$values[0];iconPath=$values[1];bigIcon=$values[2];smallIcon=$values[3];verified=($values[0] -eq $v.appId -and $values[1] -eq $v.iconPath -and $values[2] -eq $big.ToInt64().ToString() -and $values[3] -eq $small.ToInt64().ToString())}
  }
  Save-Status @{status=if($items.Count){'applied'}else{'waiting_for_window'};windows=$items;appId=$v.appId;iconPath=$v.iconPath;updatedAt=[DateTime]::UtcNow.ToString('o')}
  Start-Sleep -Milliseconds 1000
 }
} catch {Save-Status @{status='error';message=$_.Exception.Message};exit 1}
finally {
 if([FlockWindowIdentity]::Alive([int]$v.pid,$v.executablePath,$v.startTime)){
  foreach($handle in @($original.Keys)){
   try {
    if(!(Owned-Process)){break}
    $before=$original[$handle];$appid=if($null -eq $before[0]){[string][char]1}else{$before[0]};$icon=if($null -eq $before[1]){[string][char]1}else{$before[1]}
    [FlockWindowIdentity]::Apply($handle,[int]$v.pid,$v.executablePath,$v.startTime,$appid,$icon,[IntPtr]([long]$before[2]),[IntPtr]([long]$before[3]))|Out-Null
   } catch { }
  }
 }
 if($big -ne [IntPtr]::Zero){[FlockWindowIdentity]::DestroyIcon($big)|Out-Null};if($small -ne [IntPtr]::Zero){[FlockWindowIdentity]::DestroyIcon($small)|Out-Null}
}
