/** Keep the original learning visual system inside its module boundary. */
export function scopedLearningCss(css:string,scope:string):string {
  return `@scope (${scope}) { ${css.replaceAll(':root',':scope').replace(/(^|[},\s])body(?=[,{\s])/g,'$1:scope')} }`;
}
