import type { Model, ResolvedDecl, ResolvedTypeRef } from "./types.js";

export function printSource(model: Model): string {
  const out: string[] = ["typeDiagram", ""];
  for (const d of model.decls) {
    out.push(printDecl(d));
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

function printDecl(d: ResolvedDecl): string {
  const generics = d.generics.length === 0 ? "" : `<${d.generics.join(", ")}>`;
  if (d.kind === "record") {
    const fields = d.fields.map((f) => `  ${f.name}: ${printRef(f.type)}`).join("\n");
    return `type ${d.name}${generics} {\n${fields}\n}`;
  }
  if (d.kind === "union") {
    const variants = d.variants
      .map((v) => {
        const discriminant = v.discriminant === undefined ? "" : ` = ${v.discriminant}`;
        if (v.fields.length === 0) {
          return `  ${v.name}${discriminant}`;
        }
        const inner = v.fields.map((f) => `${f.name}: ${printRef(f.type)}`).join(", ");
        return `  ${v.name}${discriminant} { ${inner} }`;
      })
      .join("\n");
    return `union ${d.name}${generics} {\n${variants}\n}`;
  }
  return `alias ${d.name}${generics} = ${printRef(d.target)}`;
}

function printRef(t: ResolvedTypeRef): string {
  if (t.args.length === 0) {
    return t.name;
  }
  return `${t.name}<${t.args.map(printRef).join(", ")}>`;
}
