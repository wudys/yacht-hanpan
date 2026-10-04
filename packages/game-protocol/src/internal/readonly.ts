/** Read-only views of parsed wire data; this does not freeze objects at runtime. */
export type DeepReadonly<T> = T extends string | number | boolean | null | undefined
  ? T
  : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };
