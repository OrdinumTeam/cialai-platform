#!/usr/bin/env python3
"""nb.py — Nano Banana Pro (gemini-3-pro-image) DIRETO na Gemini API.
Serve para anonimizar telas e para compor os slides (mesmo modelo).

Uso:
  GEMINI_API_KEY=... <venv>/bin/python nb.py OUT.png <1K|2K|4K> <ASPECT> PROMPT.txt [REF1 REF2 ...]

  OUT.png   arquivo de saída
  SIZE      image_size: 1K | 2K | 4K
  ASPECT    aspect_ratio, ex.: 9:16 | 16:9 | 3:2
  PROMPT.txt caminho do prompt (texto) — entra como ÚLTIMA part
  REF*      imagens de referência (opcionais) — entram ANTES do texto
            (anonimização: REF = o print real; composição: REF = a tela anonimizada)
"""
import os, sys, pathlib
from google import genai
from google.genai import types

if len(sys.argv) < 5:
    print("uso: nb.py OUT.png <1K|2K|4K> <ASPECT> PROMPT.txt [REFS...]"); sys.exit(1)

out_path, size, aspect, prompt_path = sys.argv[1:5]
refs = sys.argv[5:]

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
parts = [types.Part.from_bytes(data=pathlib.Path(p).read_bytes(), mime_type="image/png") for p in refs]
parts.append(pathlib.Path(prompt_path).read_text())

resp = client.models.generate_content(
    model="gemini-3-pro-image",  # Nano Banana Pro
    contents=parts,
    config=types.GenerateContentConfig(
        response_modalities=["IMAGE"],
        image_config=(types.ImageConfig(image_size=size) if aspect.lower() in ("native", "-", "")
                      else types.ImageConfig(aspect_ratio=aspect, image_size=size)),
    ),
)

ok = False
for p in resp.candidates[0].content.parts:
    if getattr(p, "inline_data", None):
        pathlib.Path(out_path).write_bytes(p.inline_data.data); print("SAVED", out_path); ok = True
    elif getattr(p, "text", None):
        print("TEXT:", p.text[:300])
if not ok:
    print("NO IMAGE RETURNED"); sys.exit(2)
