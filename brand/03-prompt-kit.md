# 03 · Prompt kit

Prompts oficiais e fluxo de geração. Tudo aqui foi executado e produziu os
PNGs aprovados em `logo/`. Para regerar ou derivar peças, use estes textos
sem reescrever os blocos de regra.

## Fluxo de geração

| Item | Valor |
|------|-------|
| Modelo | `gemini-3-pro-image-preview`, Nano Banana Pro |
| Endpoint | `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent` |
| Autenticação | Header `x-goog-api-key` com `GEMINI_API_KEY` do ambiente |
| Resolução | `generationConfig.imageConfig.imageSize` em `"2K"` ou `"4K"`, `aspectRatio` em `"1:1"` para símbolo e `"16:9"` para assinatura |
| Modalidades | `responseModalities: ["TEXT", "IMAGE"]` |
| Referências | Imagens anexadas como `inlineData` antes do texto, na ordem citada no prompt |

Lições que valem para qualquer peça nova:

1. Anexar sempre um PNG aprovado como referência. Descrição sem imagem perde a família.
2. Para trocar parte da composição, compor duas referências, uma para cada parte, e mandar descartar o resto de cada uma. Anexar uma peça de corpo inteiro e pedir busto faz o modelo manter as patas.
3. Fotos do inseto real entram só como referência de anatomia da cabeça, com isso dito no prompt.
4. Para 4K, anexar a peça 2K e pedir reprodução exata. O resultado sai fiel, com desvio mínimo em pontas finas.
5. Para colocar o símbolo dentro de uma composição nova, anexar um RECORTE APERTADO da cabeça, não o PNG inteiro. Com o PNG 1:1 inteiro o modelo trata a referência como canvas e deixa um fantasma da cabeça na posição original.
6. Para peça wide, passar `aspectRatio` `"16:9"`. Em 2K sai 2752 x 1536, em 4K sai 5504 x 3072.
7. Não pedir ao modelo inversão de cores nem knockout do símbolo sobre fundo sólido: saiu com faixas brancas, formas borradas e face invertida em três tentativas. Versões monocromáticas são feitas à mão em vetor.
8. Entregar o bruto antes de qualquer reparo por pixel.

### Chamada mínima em Python

```python
import base64, json, os, urllib.request

MODEL = "gemini-3-pro-image-preview"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"

def gen(prompt, refs, out, size="2K"):
    parts = [{"inlineData": {"mimeType": "image/png",
              "data": base64.b64encode(open(r, "rb").read()).decode()}} for r in refs]
    parts.append({"text": prompt})
    body = {"contents": [{"parts": parts}],
            "generationConfig": {"responseModalities": ["TEXT", "IMAGE"],
                                 "imageConfig": {"aspectRatio": "1:1", "imageSize": size}}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    data = json.load(urllib.request.urlopen(req, timeout=900))
    for part in data["candidates"][0]["content"]["parts"]:
        if "inlineData" in part:
            open(out, "wb").write(base64.b64decode(part["inlineData"]["data"]))
```

### Recorte apertado do símbolo para referência

Os PNGs têm fundo transparente, então o recorte usa o canal alfa e compõe
sobre branco antes de anexar, porque o modelo recebe a referência em RGB.

```python
from PIL import Image
im = Image.open("logo/cialai-mantis-v4-1-head-4k.png").convert("RGBA")
x0, y0, x1, y1 = im.getchannel("A").getbbox()
pad = 80
crop = im.crop((x0 - pad, y0 - pad, x1 + pad, y1 + pad))
flat = Image.new("RGB", crop.size, (255, 255, 255))
flat.paste(crop, (0, 0), crop)
flat.save("head-crop.png")
```

## Blocos reutilizáveis

Cole estes blocos no fim de qualquer prompt novo.

### HEAD RULE

```
HEAD RULE, mandatory, faithful to the real Hymenopus coronatus: a small narrow face shaped like a downward-pointing triangle; two SHORT CONICAL compound eyes that project to the upper-left and upper-right like stubby pointed horns, each cone ending in a tip, the cones no longer than the face is tall; a tiny pointed crown bump between the two eye cones; two thin straight antennae emerging from between the eyes; a small dark mouth point at the bottom tip of the face. Face pale blush and white, eye cones carry the magenta accent. No round cartoon eyes, no wide hexagonal head, no eyes drawn as flat ovals on the face.
```

### STYLE RULE

```
STYLE RULE: pure flat vector, only solid color fills, absolutely no gradients, no shading, no darker facet planes, no fake folds, no shadow, no texture, no 3D, no photorealism, no outline stroke, shapes separated by clean white gaps. Palette pink dominant: deep magenta #E23B84, mid hot pink #FF7AB2, pale blush #FFD6E6, pure white gaps and face, deep plum #3A1B33 only for antennae and the mouth point. Centered on a pure white background, equal margin on all sides, crisp vector edges, readable at 32 pixels. No text, no letters, no words, no watermark, no background elements.
```

## Símbolo · cabeça

Gerou a cabeça em 2K, hoje substituída pela versão 4K.

Referência anexada: o busto sobre a flor, peça aposentada, como Image 1. Para regerar hoje, anexar `logo/cialai-mantis-v4-1-head-4k.png` no lugar e pedir reprodução exata.
Resolução: 2K.

```
Image 1 is the approved logo: an orchid mantis bust, head with two short conical eyes and a crown bump, thin antennae, neck, chest, two raptorial forelegs folded in a V, placed over a five-petal orchid flower, flat vector, pink palette, white gaps between shapes.

Make the HEAD-ONLY MARK derived from it, for favicon and 16 pixel uses. Draw only the mantis head from Image 1, greatly enlarged and centered: the pale blush triangular face, the two short conical magenta eyes projecting to the upper-left and upper-right, the small crown bump between them, two thin straight plum antennae, and a small dark mouth point at the bottom tip. Behind the head, one single top petal in mid hot pink, the same shape as the top petal in Image 1, as the only reference to the flower. Nothing else: no forelegs, no chest, no other petals. Bold, compact, bilaterally symmetric, extremely reduced.

STYLE RULE: pure flat vector, only solid color fills, no gradients, no shading, no darker facet planes, no shadow, no texture, no 3D, no outline stroke. Palette: deep magenta #E23B84, mid hot pink #FF7AB2, pale blush #FFD6E6, pure white, deep plum #3A1B33. Centered, equal margin on all sides, crisp vector edges. No text, no letters, no words, no watermark, no background elements.
```

## Símbolo · cabeça em 4K

Gerou `logo/cialai-mantis-v4-1-head-4k.png`.

Referência anexada: a cabeça em 2K.
Resolução: 4K, `aspectRatio` `"1:1"`.

```
Reproduce the attached image EXACTLY, as a faithful high-resolution upscale. Same composition, same shapes, same proportions, same positions, same colors, same white background, same margins. Do not redesign, do not add, do not remove, do not move or restyle anything. Only render it larger with perfectly crisp flat vector edges, no blur, no gradients, no shading, no texture, no noise, no outline stroke, no text, no watermark.
```

O mesmo prompt gerou `logo/cialai-lockup-1-4k.png` a partir da assinatura em 2K, com `aspectRatio` `"16:9"`. A versão 2K foi substituída pela 4K.

## Assinatura horizontal · símbolo e nome

Gerou a assinatura em 2K, hoje substituída por `logo/cialai-lockup-1-4k.png`.

Referência anexada: recorte apertado da cabeça, feito com o script acima, como Image 1.
Resolução: 2K, `aspectRatio` `"16:9"`.

```
Image 1 is a small cutout of the approved brand mark: an orchid mantis head, pale blush triangular face, two short conical magenta eyes, a small crown bump, two thin plum antennae, a mouth point, with one hot-pink petal behind it. PRESERVE its shapes, proportions and colors exactly wherever you place it. The head appears exactly once in the image.

Build a HORIZONTAL LOCKUP on a wide canvas: the head mark on the left, the wordmark "Cialai" on the right, on one line, the lockup filling about eighty percent of the canvas width. The head height matches the height from the baseline to the top of the C plus the antennae rising above. The gap between head and word equals the width of the letter i. The letters are set in mid hot pink #FF7AB2 with the dots of both i in deep magenta #E23B84.

WORDMARK RULE: the brand name is written exactly as "Cialai", spelled C-i-a-l-a-i, capital C followed by lowercase i a l a i, six letters, nothing else, no tagline, no other letters. The lettering is CUSTOM and shares the DNA of the mark: every stroke is built from the same soft rounded petal curves as the petal and the face, bowls of the a and the C shaped like orchid petals, stroke ends softly tapered like petal tips, uniform stroke weight, generous even spacing, perfectly horizontal baseline. Where a stroke meets another stroke, a thin white gap separates them, the same white-gap construction used in the mark. It must not look like a generic typeface; it must look drawn by the same hand that drew the head. Flat, crisp vector edges, no italic, no serif, no outline, no shadow, no gradient.

STYLE RULE: pure flat vector, only solid color fills, no gradients, no shading, no shadow, no texture, no 3D, no outline stroke. Palette: deep magenta #E23B84, mid hot pink #FF7AB2, pale blush #FFD6E6, pure white, deep plum #3A1B33. Pure white background, wide 16:9 canvas, the whole lockup centered with equal margin on all sides, no ghost or faded shapes anywhere. No watermark, no background elements.
```

O bloco WORDMARK RULE acima é o bloco oficial do lettering. Reutilizar em qualquer assinatura nova.

## Linhagem · busto na flor, peça aposentada

Gerou o busto frontal sobre orquídea de cinco pétalas, de onde o símbolo foi derivado. A peça foi aposentada e apagada; o prompt fica só para reconstruir a linhagem.

Foi composta a partir de duas peças intermediárias que já foram apagadas: um
busto em oração dentro de disco e um louva-a-deus de corpo inteiro visto de
cima formando flor. Os prompts das duas ficam abaixo para o caso de ser
preciso reconstruir a linhagem.

Referências anexadas: busto como Image 1, flor como Image 2.
Resolução: 2K.

```
Composite two approved logos from the same family into one new logo.

Image 1 is the BUST source: take the mantis bust exactly as drawn there, the head with the two short conical eyes and crown bump, the neck, the chest, and the two raptorial forelegs folded in a V on each side with white spine notches. DISCARD the pale pink disc behind it.

Image 2 is the FLOWER source: take ONLY the five-petal orchid flower, the two large pale side petals with magenta edges, the two lower pale petals, the top hot-pink petal and the bottom hot-pink petal. DISCARD the entire insect drawn on top of it, including all of its legs, lobes and abdomen; none of that insect may survive.

Result: the bust from Image 1 placed on the flower from Image 2, scaled so the head sits inside the top petal and the chest ends around the center of the flower, leaving the bottom petal and the two lower petals fully visible and empty. Below the chest there is nothing but flower. No walking legs anywhere. White gaps separate the bust from the petals behind, as in both sources. Bilaterally symmetric.

STYLE RULE: pure flat vector, only solid color fills, no gradients, no shading, no darker facet planes, no shadow, no texture, no 3D, no outline stroke. Palette pink dominant: deep magenta #E23B84, mid hot pink #FF7AB2, pale blush #FFD6E6, pure white, deep plum #3A1B33 only for antennae and mouth point. Centered on a pure white background, equal margin on all sides, crisp vector edges. No text, no letters, no words, no watermark, no background elements.
```

### Peça intermediária · busto em oração no disco

Referências anexadas: um brasão frontal da família como Image 1, duas fotos
reais do inseto como Image 2 e Image 3.

```
Image 1 is a logo from the same brand family: use it ONLY as a reference for visual style, palette, flatness and the white-gap construction. Do NOT reproduce its composition, its petal shield or its arm layout; the result must be a clearly different logo that a viewer recognizes as a sibling, not a variation. Images 2 and 3 are photographs of the real orchid mantis and are references for the HEAD ANATOMY ONLY, not for photographic style, background or pose.

CONCEPT: praying bust inside a solid disc. A solid circle of pale blush #FFD6E6 fills most of the canvas. Inside it, a frontal bust of the mantis: the head at the top, a short neck segment, and the two raptorial forelegs folded tightly together in front of the chest in the classic praying pose, forearms pointing up and inward so the two tibiae almost touch under the chin. The forelegs are magenta with white spine notches on the inner edge. No petals, no lobes, no legs, no flower anywhere. The bust is cut off cleanly at the bottom of the disc. Bilaterally symmetric, bold and simple, like a coin or a seal.
```

Seguido dos blocos HEAD RULE e STYLE RULE.

### Peça intermediária · corpo inteiro visto de cima

Mesmas referências da peça anterior.

```
Image 1 is a logo from the same brand family: use it ONLY as a reference for visual style, palette, flatness and the white-gap construction. Do NOT reproduce its composition, its petal shield or its arm layout; the result must be a clearly different logo that a viewer recognizes as a sibling, not a variation. Images 2 and 3 are photographs of the real orchid mantis and are references for the HEAD ANATOMY ONLY, not for photographic style, background or pose.

CONCEPT: top-down view, the mantis as a radial flower. The mantis is seen from directly above, head at the top, body as a vertical spine down the middle, and its four walking legs spread out symmetrically to the sides with the big orchid-petal lobes on each femur, so the four lobes plus the tip of the abdomen at the bottom form a five-petal flower outline. The two raptorial forelegs are folded forward on either side of the head. Bilaterally symmetric, radial, compact. The body and lobes are pale blush, the leg segments and the outer edge of each lobe are magenta, white gaps between every segment. No actual flower, no leaf, no circle behind.
```

Seguido dos blocos HEAD RULE, com a nota "seen from above: the two eye cones
stick out to the sides of the head like short horns, the crown bump between
them pointing up, antennae rising above", e STYLE RULE.

## Derivações futuras

Para qualquer peça nova, a estrutura do prompt é:

1. Uma linha dizendo o que é a Image 1, recorte apertado do símbolo, e que ela deve ser preservada.
2. O que muda, dito em termos de composição, nunca de estilo.
3. O que é proibido aparecer, listado nominalmente, incluindo fantasma da referência.
4. WORDMARK RULE, se houver nome.
5. HEAD RULE.
6. STYLE RULE.
