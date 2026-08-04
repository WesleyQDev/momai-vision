# MomAI Vision

A MomAI Vision dá olhos à MomAI: snapshots de câmeras (webcam + IP/MJPEG),
descrição de cena com o modelo de visão local e monitoramento com alertas —
funcionando mesmo com a MomAI minimizada.

## Ferramentas

| Ferramenta | Uso |
| --- | --- |
| `list_cameras` | Lista câmeras (webcam/IP) com status e monitors ativos |
| `capture_snapshot {cameraId?}` | Captura e descreve a cena ("o que você vê aí?") |
| `describe_snapshot {snapshotId}` | Re-descreve um snapshot da galeria |
| `start_monitoring {cameraId, triggers[], ...}` | Inicia monitoramento com alertas |
| `stop_monitoring {monitorId?}` | Para monitoramento(s) |
| `get_status` | Monitors ativos por câmera |
| `list_snapshots {limit?}` | Galeria (mais recentes primeiro) |

## Triggers (start_monitoring)

```json
{
  "cameraId": "webcam:<deviceId>",
  "triggers": [{ "type": "motion", "sensitivity": "med" }],
  "schedule": { "days": [0,1,2,3,4,5,6], "start": "22:00", "end": "06:00" },
  "cooldownSec": 120,
  "notify": { "native": true, "chat": true },
  "label": "Garagem"
}
```

- `motion` — movimento (absdiff); `sensitivity`: low/med/high; `minArea`.
- `object` — detecção COCO: `className` (person, cat, dog, car…), `minConfidence`, `present`.
- `presence`/`absence` — `className` (default person), `event`: entered/left/still_present, `windowSec`.
- `scene` — pergunta SIM/NÃO via visão local: `question`, `everySec` (15-300), `onAnswer`: yes/no/change, `confirmN`.
- `periodic` — resumo periódico: `everySec`, `task`.
- `schedule.days`: 0-6 (domingo=0). `confirm: true` retorna o plano para o usuário confirmar antes de iniciar.

## Como usar (gramática)

- "o que você vê aí?" → `capture_snapshot`
- "me avise quando alguém chegar em casa" → `start_monitoring` com `presence entered` (person)
- "vigia a garagem de madrugada" → `motion` + `schedule` 22h-6h + cooldown
- "avise se alguém ficar parado na porta por 2 minutos" → `presence still_present` windowSec 120
- "me avise se o gato subir na mesa" → `motion` (gate) + `scene` "tem um gato na mesa?"
- "avise se a porta da frente estiver aberta" → `scene` "a porta da frente está aberta?"
- "avise quando deixarem uma encomenda na porta" → `motion` + `scene` "tem uma encomenda na porta?"
- "avise quando eu voltar pra sala" → `presence entered`

Quando o usuário não especificar a câmera, use a câmera padrão (config). Se houver
mais de uma câmera e não houver padrão, pergunte qual.

## Honestidade (limites que a MomAI declara)

- **Identidade**: detecto "uma pessoa", não "quem" (ex.: "meu filho"). Sem reconhecimento facial.
- **Não-visual/oculto**: temperatura, trinco, outro cômodo — não detecto.
- **Transientes curtos**: um passarinho que passa rápido pode não ser captado.
- **Iluminação/clima**: noite sem IR, chuva, reflexos reduzem a qualidade.
- **Geometria/escala**: objeto muito pequeno ou distante não é detectado.
- **Subjetivo**: "está arrumado", "está triste" — não consigo avaliar; refinar para uma pergunta verificável.
- "Encomenda/pacote", "porta aberta", "luz acesa" **não são classes COCO** — use `scene` com pergunta SIM/NÃO (muitas vezes combinado com `motion` como gate).

## Fluxo de monitoramento

1. Antes de iniciar, **anuncie o plano** ao usuário (câmera, triggers, horário, cooldown) e confirme.
2. Chame `start_monitoring` (sem `confirm:true` na chamada final).
3. Ao disparar um trigger: snapshot salvo na galeria + **overlay flutuante** com a imagem + cartão no chat (`vision_alert`) + entrada no feed de alertas da página.
4. Para parar: `stop_monitoring {monitorId}` — ou o usuário para pela página/overlay.

## Performance

- Orçamento padrão: 1fps por câmera. Com muitas câmeras ativas, o sistema pode reduzir a taxa.
- Motion (gate barato) roda primeiro; detecção YOLO e visão só quando necessário.
- Cooldown/dedupe por monitor evita alertas repetidos.

## Privacidade

- Frames ficam só em memória (nunca em disco).
- Snapshots ficam no diretório local da extensão (7 dias / máx 200 / 100MB, configurável).
- Visão e detecção são 100% locais — nenhum pixel sai da máquina.
