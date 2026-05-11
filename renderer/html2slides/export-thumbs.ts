import { exportThumbs } from "./export-thumbs-lib";

const presId = process.argv[2] || "1JzxZYfftmDqJ-cyOfw4hHNFISwvdX7EXme-HYyEETRQ";
const outDir = process.argv[3] || "/tmp/slides-v2-thumbs";

exportThumbs({ presId, outDir }).catch(e => { console.error(e); process.exit(1); });
