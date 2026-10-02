// A picture chosen from this computer, made ready the way the app makes one
// ready (`MediaStore.saveReporting`): downsampled so its long side is at most
// 2400 px, sent as the bytes it will be stored as (so `bytes_sha` names the
// file that exists, C-65), an animated GIF kept as it is.

const Upload = (() => {

  const LONG_SIDE = 2400;
  const MAX_BYTES = 5 * 1024 * 1024;

  // A file input opened on demand, never left in the page.
  function pick(accept) {
    return new Promise(resolve => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.className = "hidden-input";
      input.addEventListener("change", () => { resolve(input.files && input.files[0] ? input.files[0] : null); input.remove(); });
      document.body.appendChild(input);
      input.click();
      setTimeout(() => { if (!input.files || !input.files.length) { /* cancelled or still open */ } }, 0);
    });
  }

  async function prepare(file) {
    const type = (file.type || "").toLowerCase();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) {
      throw new Error("Choose a PNG, JPEG, GIF or WebP picture.");
    }
    if (type === "image/gif" && file.size <= MAX_BYTES) return { blob: file, mime: "image/gif" };
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= MAX_BYTES && type !== "image/gif") return { blob: file, mime: type };
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const mime = type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, 0.86));
    if (!blob) throw new Error("That picture could not be read.");
    if (blob.size > MAX_BYTES) {
      const smaller = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.72));
      return { blob: smaller, mime: "image/jpeg" };
    }
    return { blob, mime };
  }

  return { pick, prepare };
})();
