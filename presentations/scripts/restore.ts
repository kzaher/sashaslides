import CDP from "chrome-remote-interface";

async function main() {
  let client: any;
  try {
    client = await CDP({ port: 9222 });
    const { Page, Input } = client;
    
    await Page.enable();
    
    // Undo multiple times to restore
    for (let i = 0; i < 40; i++) {
      await Input.dispatchKeyEvent({
        type: "rawKeyDown",
        key: "Control",
        windowsVirtualKeyCode: 17,
        nativeVirtualKeyCode: 17,
      });
      await Input.dispatchKeyEvent({
        type: "rawKeyDown",
        key: "z",
        windowsVirtualKeyCode: 90,
        nativeVirtualKeyCode: 90,
      });
      await new Promise(r => setTimeout(r, 10));
      await Input.dispatchKeyEvent({
        type: "keyUp",
        key: "z",
        windowsVirtualKeyCode: 90,
        nativeVirtualKeyCode: 90,
      });
      await Input.dispatchKeyEvent({
        type: "keyUp",
        key: "Control",
        windowsVirtualKeyCode: 17,
        nativeVirtualKeyCode: 17,
      });
      await new Promise(r => setTimeout(r, 100));
    }
    
    console.log("Restored presentation");
  } finally {
    if (client) await client.close();
  }
}

main();
