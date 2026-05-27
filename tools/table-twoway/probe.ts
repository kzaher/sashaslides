import { readFileSync } from "fs";
import { PNG } from "pngjs";
const px = (p: PNG, x: number, y: number) => {
  const i = (y * p.width + x) * 4;
  return `${p.data[i].toString(16).padStart(2,'0')}${p.data[i+1].toString(16).padStart(2,'0')}${p.data[i+2].toString(16).padStart(2,'0')}`;
};
for (const f of ["F01", "F05", "F11"]) {
  const a = PNG.sync.read(readFileSync(`/tmp/twoway-sxs/originals/${f}.png`));
  console.log(`--- ${f} NATIVE right edge — probe x range across right edge at y=100 ---`);
  // F1/F5 right edge ~x=880, F11 right edge ~x=784
  const xs = f === "F11" ? [780, 781, 782, 783, 784, 785, 786, 787] : [876, 877, 878, 879, 880, 881, 882, 883];
  for (const x of xs) console.log(`  x=${x}  ${px(a, x, 100)}`);
}
