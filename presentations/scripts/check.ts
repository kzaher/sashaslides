import CDP from "chrome-remote-interface";

async function main() {
  let client: any;
  try {
    client = await CDP({ port: 9222 });
    const { Runtime } = client;
    
    const result = await Runtime.evaluate({
      expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
      returnByValue: true,
    });
    console.log(`Thumbnails: ${result.result.value}`);
    
    const docResult = await Runtime.evaluate({
      expression: `document.body.innerHTML.length`,
      returnByValue: true,
    });
    console.log(`Page HTML length: ${docResult.result.value}`);
  } finally {
    if (client) await client.close();
  }
}

main();
