using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using System.Xml;
using Roche.LC120.Core;
using Roche.LC120.Infrastructure.Interface.Services;
using Roche.LC120.Infrastructure.Services;

// ============================================================================
// qPCR Engine Bridge (x86, .NET Framework)
// Wraps the original Roche LightCycler 96 Kinetic engine (CalculationPackageService)
// into a stdin/stdout JSON protocol so a modern web backend can call it.
//
// Usage: engine-bridge.exe <binDir> <adfPath>
//   stdin : {"inputs":[{"positionId":"2","channelId":0,"points":[[1,0.0354],...]}, ...]}
//   stdout: {"ok":true,"results":[{"channel":0,"position":"2","params":{"26 CT1":"27.05",...}}]}
//   or    : {"ok":false,"error":"..."}
// ============================================================================
class EngineBridge
{
    static string binDir;

    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        try
        {
            if (args.Length < 2) { Fail("usage: engine-bridge.exe <binDir> <adfPath>"); return 1; }
            binDir = Path.GetFullPath(args[0]);
            string adfPath = Path.GetFullPath(args[1]);
            if (!File.Exists(adfPath)) { Fail("ADF not found: " + adfPath); return 1; }

            AppDomain.CurrentDomain.AssemblyResolve += (s, e) => {
                string name = new AssemblyName(e.Name).Name;
                string cand = Path.Combine(binDir, name + ".dll");
                if (File.Exists(cand)) return Assembly.LoadFrom(cand);
                string al = Path.Combine(binDir, "AlgorithmLibraries");
                if (Directory.Exists(al))
                    foreach (var f in Directory.GetFiles(al, name + ".dll", SearchOption.AllDirectories))
                        return Assembly.LoadFrom(f);
                return null;
            };
            Directory.SetCurrentDirectory(binDir);

            // read job from stdin
            string jobJson = ReadAllStdin();
            if (string.IsNullOrWhiteSpace(jobJson)) { Fail("no job on stdin"); return 1; }
            var ser = new JavaScriptSerializer();
            var job = ser.Deserialize<Job>(jobJson);
            if (job == null || job.inputs == null || job.inputs.Length == 0) { Fail("job.inputs empty"); return 1; }

            // build GraphInputs
            var inputs = new List<GraphInput>();
            foreach (var inp in job.inputs)
            {
                if (inp.points == null || inp.points.Length == 0) continue;
                var pts = new List<DoublePoint>();
                foreach (var p in inp.points)
                    pts.Add(new DoublePoint { X = p[0], Y = p[1] });
                if (pts.Count == 0) continue;
                inputs.Add(new GraphInput { PositionId = inp.positionId, ChannelId = inp.channelId, Fluoerscences = pts });
            }
            if (inputs.Count == 0) { Fail("no valid input curves"); return 1; }

            // load ADF (signature requires whitespace preservation)
            var adfDoc = new XmlDocument();
            adfDoc.PreserveWhitespace = true;
            adfDoc.Load(adfPath);
            string algoLib = Path.Combine(binDir, "AlgorithmLibraries");

            var svc = new CalculationPackageService();
            var results = svc.Calculate(inputs, adfDoc, algoLib).ToList();

            var outResults = new List<object>();
            foreach (var gr in results)
            {
                var dict = new Dictionary<string, object>();
                foreach (var kv in gr.Result)
                {
                    object v = kv.Value;
                    if (v is double)
                    {
                        double d = (double)v;
                        if (double.IsNaN(d) || double.IsInfinity(d)) v = null;
                        else v = Math.Round(d, 8);   // keep JSON compact; display rounding happens on frontend
                    }
                    else if (v is float)
                    {
                        float f = (float)v;
                        if (float.IsNaN(f) || float.IsInfinity(f)) v = null;
                        else v = Math.Round(f, 8);
                    }
                    dict[kv.Key] = v;
                }
                outResults.Add(new { channel = gr.ChannelId, position = gr.PositionId, @params = dict });
            }
            var resp = new { ok = true, count = outResults.Count, results = outResults };
            Console.WriteLine(ser.Serialize(resp));
            return 0;
        }
        catch (Exception ex)
        {
            var sb = new StringBuilder();
            Exception cur = ex;
            while (cur != null)
            {
                if (sb.Length > 0) sb.Append(" | ");
                sb.Append(cur.GetType().Name).Append(": ").Append(cur.Message);
                cur = cur.InnerException;
            }
            Fail(sb.ToString());
            return 1;
        }
    }

    static void Fail(string msg)
    {
        var ser = new JavaScriptSerializer();
        Console.WriteLine(ser.Serialize(new { ok = false, error = msg }));
    }

    static string ReadAllStdin()
    {
        using (var stdin = Console.OpenStandardInput())
        using (var reader = new StreamReader(stdin, Encoding.UTF8))
            return reader.ReadToEnd();
    }

    class Job
    {
        public InputItem[] inputs { get; set; }
    }
    class InputItem
    {
        public string positionId { get; set; }
        public int channelId { get; set; }
        public double[][] points { get; set; }
    }
}