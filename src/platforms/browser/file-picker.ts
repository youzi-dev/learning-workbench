import type {FilePort, LocalFileRef} from '../../workbench/contracts/files';
/** The transient picker is a bounded source only; DurableStaging owns saved bytes. */
export function createBrowserFilePicker(documentPort: Document = document): FilePort {
  const selected = new Map<string, File>();
  return {
    async import() {
      return new Promise(resolve => {
        const input = documentPort.createElement('input');
        input.type = 'file'; input.multiple = true;
        input.accept = '.pdf,.epub,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.mp4,.webm,.mp3,.wav';
        let settled = false;
        const finish = (refs: LocalFileRef[]) => {if (settled) return; settled = true; input.remove(); resolve(refs);};
        input.addEventListener('change', () => {
          const refs = [...input.files ?? []].map(file => {
            const ref = {token: `picked:${crypto.randomUUID()}`, name: file.name, mime: file.type || guessMime(file.name), size: file.size};
            selected.set(ref.token, file); return ref;
          });
          finish(refs);
        }, {once: true});
        input.addEventListener('cancel', () => finish([]), {once: true});
        input.hidden = true; documentPort.body.append(input); input.click();
      });
    },
    async stage(ref) {if (!selected.has(ref.token)) throw Error('所选文件已失效，请重新选择'); return ref;},
    async read(ref, offset, length) {
      const file = selected.get(ref.token);
      if (!file) throw Error('所选文件已失效，请重新选择');
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 1_048_576 || offset + length > file.size) throw Error('INVALID_RANGE');
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    },
  };
}
export function guessMime(name: string): string {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  return ({pdf: 'application/pdf', epub: 'application/epub+zip', txt: 'text/plain', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav'} as Record<string, string>)[extension] ?? 'application/octet-stream';
}
