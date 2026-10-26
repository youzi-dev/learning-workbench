export async function saveBrowserBackup(bytes: Uint8Array, name: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], {type: 'application/json'}));
  try {
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
    document.body.append(anchor); anchor.click(); anchor.remove();
  } finally {setTimeout(() => URL.revokeObjectURL(url), 1000);}
}
