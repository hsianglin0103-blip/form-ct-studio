// Preserve every computed raster sample, grouped only by its displayed RGB color.
export function exactPixelPaths(values, width, height, colorForValue) {
  if (width < 1 || height < 1 || values.length !== width * height) throw new Error('Invalid 2D reading grid.');
  const groups = new Map();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = colorForValue(values[x + y * width]);
    if (!groups.has(color)) groups.set(color, []);
    groups.get(color).push(`M${x} ${y}h1v1h-1z`);
  }
  return [...groups].map(([color, commands]) => ({ color, d: commands.join(''), cells: commands.length }));
}

// Merge only identical neighboring RGB pixels along a row. This changes no
// displayed color or position, while keeping detailed CT SVG files manageable.
export function exactRGBPaths(pixels, width, height) {
  if (width < 1 || height < 1 || pixels.length !== width * height * 4) throw new Error('Invalid detailed CT image.');
  const groups = new Map();
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const offset = (y * width + x) * 4;
      const key = (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2];
      let run = 1;
      while (x + run < width) {
        const next = (y * width + x + run) * 4;
        if (((pixels[next] << 16) | (pixels[next + 1] << 8) | pixels[next + 2]) !== key) break;
        run++;
      }
      if (!groups.has(key)) groups.set(key, { commands: [], cells: 0 });
      const group = groups.get(key);
      group.commands.push(`M${x} ${y}h${run}v1h-${run}z`);
      group.cells += run;
      x += run;
    }
  }
  return [...groups].map(([key, group]) => ({
    color: `rgb(${key >> 16},${(key >> 8) & 255},${key & 255})`,
    d: group.commands.join(''), cells: group.cells,
  }));
}
