using System;
using System.Diagnostics;
using System.Threading;
using System.IO;
using System.Net.Sockets;
using System.Windows.Forms;

namespace OpsApp
{
    class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            // 1. Path to Node.exe and server.js
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            string serverJs = Path.Combine(appDir, "server.js");
            
            if (!File.Exists(serverJs))
            {
                MessageBox.Show(
                    "Could not find 'server.js' in the application directory:\n" + appDir, 
                    "Ops Reporting - Initialization Error", 
                    MessageBoxButtons.OK, 
                    MessageBoxIcon.Error
                );
                return;
            }

            // 2. Start node server.js in hidden window
            ProcessStartInfo nodeInfo = new ProcessStartInfo();
            nodeInfo.FileName = "node";
            nodeInfo.Arguments = "\"" + serverJs + "\"";
            nodeInfo.WorkingDirectory = appDir;
            nodeInfo.CreateNoWindow = true;      // Keep it hidden
            nodeInfo.UseShellExecute = false;
            
            Process nodeProcess = null;
            try
            {
                nodeProcess = Process.Start(nodeInfo);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Failed to start the backend server. Make sure Node.js is installed on your computer.\n\nDetails: " + ex.Message, 
                    "Ops Reporting - Startup Error", 
                    MessageBoxButtons.OK, 
                    MessageBoxIcon.Error
                );
                return;
            }

            // 3. Wait for the server port 3000 to become active
            bool portOpen = false;
            for (int i = 0; i < 30; i++) // Check every 500ms for 15 seconds
            {
                try
                {
                    using (TcpClient tcpClient = new TcpClient())
                    {
                        tcpClient.Connect("127.0.0.1", 3000);
                        portOpen = true;
                        break;
                    }
                }
                catch
                {
                    Thread.Sleep(500);
                }
            }

            if (!portOpen)
            {
                try { nodeProcess.Kill(); } catch {}
                MessageBox.Show(
                    "The backend server failed to respond on port 3000 within 15 seconds.", 
                    "Ops Reporting - Connection Error", 
                    MessageBoxButtons.OK, 
                    MessageBoxIcon.Error
                );
                return;
            }

            // 4. Start Microsoft Edge in standalone App Mode (borderless)
            ProcessStartInfo edgeInfo = new ProcessStartInfo();
            edgeInfo.FileName = "msedge.exe";
            edgeInfo.Arguments = "--app=https://localhost:3000 --ignore-certificate-errors --allow-insecure-localhost";
            
            try
            {
                Process.Start(edgeInfo);
            }
            catch
            {
                // Fallback to opening standard default browser if Edge isn't found
                try
                {
                    Process.Start("https://localhost:3000");
                }
                catch (Exception ex)
                {
                    try { nodeProcess.Kill(); } catch {}
                    MessageBox.Show(
                        "Failed to open the browser application.\n\nDetails: " + ex.Message, 
                        "Ops Reporting - Browser Error", 
                        MessageBoxButtons.OK, 
                        MessageBoxIcon.Error
                    );
                }
            }
        }
    }
}
