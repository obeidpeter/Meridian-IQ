import { deflateSync } from "node:zlib";

// Small, valid synthetic documents. Action strings are inert and never executed.
export function makeEvidencePdf(
  input: {
    catalog?: string;
    page?: string;
    objects?: string[];
    compressed?: boolean;
  } = {},
): Buffer {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${input.catalog ?? ""} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <<>> ${input.page ?? ""} >>`,
    ...(input.objects ?? []),
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  let length = chunks[0].length;
  const append = (value: string | Buffer) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    chunks.push(bytes);
    length += bytes.length;
  };
  if (!input.compressed) {
    const offsets = [0];
    for (let index = 0; index < objects.length; index++) {
      offsets.push(length);
      append(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
    }
    const xref = length;
    append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
    for (const offset of offsets.slice(1))
      append(`${String(offset).padStart(10, "0")} 00000 n \n`);
    append(
      `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    );
  } else {
    let body = "";
    let header = "";
    objects.forEach((object, index) => {
      header += `${index + 1} ${Buffer.byteLength(body)} `;
      body += `${object}\n`;
    });
    const compressed = deflateSync(Buffer.from(header + body));
    const streamId = objects.length + 1;
    const streamOffset = length;
    append(
      `${streamId} 0 obj\n<< /Type /ObjStm /N ${objects.length} /First ${Buffer.byteLength(header)} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
    );
    append(compressed);
    append("\nendstream\nendobj\n");
    const xrefId = streamId + 1;
    const xrefOffset = length;
    const entries = Buffer.alloc((xrefId + 1) * 7);
    entries.writeUInt16BE(65535, 5);
    for (let id = 1; id <= objects.length; id++) {
      entries[id * 7] = 2;
      entries.writeUInt32BE(streamId, id * 7 + 1);
      entries.writeUInt16BE(id - 1, id * 7 + 5);
    }
    for (const [id, offset] of [
      [streamId, streamOffset],
      [xrefId, xrefOffset],
    ]) {
      entries[id * 7] = 1;
      entries.writeUInt32BE(offset, id * 7 + 1);
    }
    append(
      `${xrefId} 0 obj\n<< /Type /XRef /Size ${xrefId + 1} /Root 1 0 R /W [1 4 2] /Length ${entries.length} >>\nstream\n`,
    );
    append(entries);
    append(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);
  }
  return Buffer.concat(chunks);
}
