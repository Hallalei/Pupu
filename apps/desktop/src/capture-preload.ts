import { contextBridge, ipcRenderer } from "electron";

/** 推流页只能收命令、发事件，碰不到别的。 */
contextBridge.exposeInMainWorld("pupuCapture", {
  fake: process.argv.includes("--pupu-fake-screen"),
  onCommand(handler: (command: unknown) => void) {
    ipcRenderer.on("capture:command", (_event, command: unknown) => handler(command));
  },
  send(event: unknown) {
    ipcRenderer.send("capture:event", event);
  },
  log(line: string) {
    ipcRenderer.send("capture:log", line);
  }
});
