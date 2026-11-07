export function computeUnifiedDiff(oldStr, newStr, filename = "file") {
  const oldLines = oldStr ? oldStr.split(/\r?\n/) : [];
  const newLines = newStr ? newStr.split(/\r?\n/) : [];
  let locAdded = 0;
  let locRemoved = 0;
  const diffLines = [];

  diffLines.push(`--- a/${filename}`);
  diffLines.push(`+++ b/${filename}`);

  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      diffLines.push(` ${oldLines[i]}`);
      i++;
      j++;
      continue;
    }

    let matchOld = -1;
    let matchNew = -1;

    for (let k = 1; k < 10; k++) {
      if (i + k < oldLines.length && j < newLines.length && oldLines[i + k] === newLines[j]) {
        matchOld = i + k;
        break;
      }
      if (j + k < newLines.length && i < oldLines.length && oldLines[i] === newLines[j + k]) {
        matchNew = j + k;
        break;
      }
    }

    if (matchOld !== -1) {
      while (i < matchOld) {
        diffLines.push(`-${oldLines[i]}`);
        locRemoved++;
        i++;
      }
    } else if (matchNew !== -1) {
      while (j < matchNew) {
        diffLines.push(`+${newLines[j]}`);
        locAdded++;
        j++;
      }
    } else {
      if (i < oldLines.length) {
        diffLines.push(`-${oldLines[i]}`);
        locRemoved++;
        i++;
      }
      if (j < newLines.length) {
        diffLines.push(`+${newLines[j]}`);
        locAdded++;
        j++;
      }
    }
  }

  const header = `@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  diffLines.splice(2, 0, header);

  return {
    locAdded,
    locRemoved,
    patch: diffLines.join("\n")
  };
}
