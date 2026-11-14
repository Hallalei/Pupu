"""本地预览用：把 tokens.json 变成 CSS 变量，近似设计规范类型页注入的样子。"""
import json, re, sys
src, dst = sys.argv[1], sys.argv[2]
t = json.load(open(src))
def name(n): return "--" + n.replace(".", "\\.")
def val(v):
    if isinstance(v, str):
        return re.sub(r"\{([^}]+)\}", lambda m: f"var({name(m.group(1))})", v)
    return v
light, dark = [], []
for tok in t["color"]["tokens"]:
    v = tok["value"]
    if isinstance(v, dict):
        light.append(f"{name(tok['name'])}: {val(v['light'])};")
        dark.append(f"{name(tok['name'])}: {val(v['dark'])};")
    else:
        light.append(f"{name(tok['name'])}: {val(v)};")
for group in ("spacing", "radius", "shadow", "size"):
    for tok in t[group]["tokens"]:
        light.append(f"{name(tok['name'])}: {tok['value']};")
fam = t["type"]["families"]
light.append(f"--font-sans: {fam['sans']};")
light.append(f"--font-mono: {fam['mono']};")
classes = []
for g in t["type"]["groups"]:
    for s in g["styles"]:
        f = "var(--font-mono)" if g["family"] == "mono" else "var(--font-sans)"
        classes.append(f".{s['name']} {{ font-family: {f}; font-size: {s['fontSize']}; line-height: {s['lineHeight']}; font-weight: {s['fontWeight']}; }}")
css = ":root {\n  " + "\n  ".join(light) + "\n}\n[data-theme=\"dark\"] {\n  " + "\n  ".join(dark) + "\n}\n" + "\n".join(classes) + "\nbody { background: var(--canvas); }\n"
open(dst, "w").write(css)
print(f"{len(light)} + {len(dark)} vars")
