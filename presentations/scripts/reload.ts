import CDP from "chrome-remote-interface";

async function main() {
  let client: any;
  try {
    client = await CDP({ port: 9222 });
    const { Page, Runtime } = client;
    
    await Page.enable();
    await Page.reload();
    
    // Wait for page to load
    await new Promise(r => setTimeout(r, 3000));
    
    const result = await Runtime.evaluate({
      expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
      returnByValue: true,
    });
    console.log(`After reload: ${result.result.value} thumbnails`);
  } finally {
    if (client) await client.close();
  }
}

main();
