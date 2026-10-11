// Worker for the WASI (Bochs) engine: the VM runs here, the page owns the terminal.
// `init` carries what createContainerWASI() resolved (runtime URL, in-browser net stack, proxy CA);
// every later message is an xterm-pty channel handoff.
importScripts(new URL("./vendor/workerTools.js", location.href).href);
importScripts(new URL("./dist/worker-util.js", location.href).href);

let info = null;
let args = null;

onmessage = (msg) => {
  const req = msg.data;
  if (typeof req === "object" && req.type === "init") {
    info = req.info;
    args = req.args;
    return;
  }
  RunContainer.startContainer(info, args, new TtyClient(req));
};
