import CDP from "chrome-remote-interface";

async function main() {
  let client: any;
  try {
    client = await CDP({ port: 9222 });
    const { Page, Runtime } = client;
    
    await Page.enable();
    // Navigate to the presentation
    await Page.navigate({ url: "https://docs.google.com/presentation/d/1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY/edit" });
    
    // Wait for page to fully load
    await new Promise(r => setTimeout(r, 5000));
    
    const result = await Runtime.evaluate({
      expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
      returnByValue: true,
    });
    console.log(`After navigation: ${result.result.value} thumbnails`);
  } finally {
    if (client) await client.close();
  }
}

main();
