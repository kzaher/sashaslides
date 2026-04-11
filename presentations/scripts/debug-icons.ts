import CDP from "chrome-remote-interface";

async function main() {
  const newTarget = await CDP.New({
    port: 9222,
    url: `file:///workspaces/sashaslides/presentations/1/icons/icons.html`,
  });
  const client = await CDP({ target: newTarget });
  const { Runtime, Page } = client;
  await Page.enable();
  await Page.loadEventFired();
  await new Promise(r => setTimeout(r, 3000));

  const r = await Runtime.evaluate({
    expression: `(() => {
      const info = {};
      info.hasRough = typeof rough !== 'undefined';
      info.title = document.title;
      info.bodyHtml = document.body.innerHTML.length;
      info.svgs = document.querySelectorAll('svg').length;
      info.firstSvgChildren = document.querySelector('svg')?.children.length;
      // Errors
      const errors = window.__errors || [];
      info.errors = errors;
      return info;
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(r.result.value, null, 2));

  await CDP.Close({ port: 9222, id: newTarget.id });
  await client.close();
}
main();
