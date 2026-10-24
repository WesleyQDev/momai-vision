---
name: Vision
description: Captura frames e vídeos de webcams e câmeras de segurança físicas instaladas, monitora presença e descreve o que está visível no campo de visão das câmeras do ambiente físico. Use quando o usuário pedir para ver através de uma câmera, verificar se alguém está no portão/porta, monitorar o ambiente físico ou tirar uma foto pela webcam.
---

# MomAI Vision

A MomAI Vision dá olhos à MomAI: snapshots de câmeras (webcam + IP/MJPEG) e
monitoramento com alertas — funcionando de forma 100% local.

## Ferramentas

| Ferramenta | Uso |
| --- | --- |
| `list_cameras` | Lista câmeras (webcam/IP) com status e monitors ativos |
| `capture_snapshot {cameraId?}` | Tira uma foto de uma CÂMERA (webcam/IP), nunca da tela do computador, e salva na galeria. Não exibe nada no chat |
| `show_snapshot {snapshotId?, cameraId?, description?}` | Exibe AO USUÁRIO no chat um print já capturado (pelo `snapshotId` do `capture_snapshot`) |
| `control_ptz {cameraId, action, ...}` | Move/consulta câmeras IP motorizadas. Use `step` (passo com parada automática) e `status` (posição pan/tilt/zoom) |
| `update_monitoring {monitorId, cameraId?, triggers?, ...}` | Edita as configurações de um monitoramento existente |
| `pause_monitoring {monitorId?}` | Pausa sem excluir: para a execução e o card some, mas os dados ficam salvos |
| `resume_monitoring {monitorId?}` | Retoma um monitoramento pausado |
| `stop_monitoring {monitorId?}` | **EXCLUI** definitivamente o monitoramento e seus dados |
| `get_status` | Monitors ativos/pausados por câmera |
| `list_snapshots {limit?}` | Galeria de fotos das câmeras (mais recentes primeiro) |

## Regra Estrita de Câmera para Snapshots

- **APENAS CÂMERAS SELECIONADAS NO PAINEL**: As ferramentas (`capture_snapshot`, `get_frame`, etc.) funcionam **apenas** nas câmeras que o usuário ativou/selecionou no painel da página MomAI Vision (`selected: true` em `list_cameras`).
- Se o usuário pedir para tirar snapshot ou interagir com uma câmera que não está selecionada/ativa no painel, informe ao usuário para abrir o painel da MomAI Vision e clicar no botão `+` para selecionar/ativar a câmera desejada.

## Captura e exibição de prints (duas ferramentas)

- `capture_snapshot` **só captura**: salva o print na galeria e devolve `snapshotId`, `cameraId`, `cameraName` e `ts`. Não gera cartão, não encerra o turno e não escreve uma resposta pronta.
- `show_snapshot` **só exibe para o usuário**: recebe o `snapshotId` devolvido por `capture_snapshot` (ou mostra o print mais recente da câmera/galeria) e renderiza o cartão do print no chat.
- `show_snapshot` **não é feedback interno**: a ferramenta não devolve a imagem para você, então não a use para "ver" a cena, verificar movimento ou reportar progresso. Use apenas quando o usuário pedir para ver a câmera/uma foto, ou no máximo uma vez para entregar o resultado final de uma captura.
- Fluxo quando o usuário pedir uma foto: chame `capture_snapshot`; se ele pediu para ver, chame `show_snapshot` uma vez com o `snapshotId` retornado e só então responda com o que fizer sentido. Nunca responda com um texto fixo do tipo "Print capturado".
- Para legendas, use `description` em `show_snapshot`. Sem legenda, o cartão usa o rótulo localizado de print.

## PTZ (câmeras motorizadas)

- `control_ptz { cameraId, action: "step", direction, durationMs?, speed? }` move um passo controlado e **para sozinho** no fim. Duração de 100 a 5000 ms (padrão 500 ms); passos curtos para ajuste fino, longos para deslocamentos maiores.
- `control_ptz { cameraId, action: "status" }` retorna `position` com `pan`, `tilt` e `zoom` (coordenadas normalizadas da câmera, não graus) e `moveStatus`. Use antes/depois de um passo para saber onde a câmera está.
- `preset` vai para uma posição salva (`presetToken`), `home` recentraliza e `stop` interrompe.
- Não existe `move` contínuo para o assistente: movimento aberto existe apenas no controle manual da interface.
- Durante um pedido de PTZ, **não chame `capture_snapshot` nem `show_snapshot` por conta própria**: o usuário está vendo o vídeo ao vivo. Só capture ou exiba uma foto se ele pedir.
- Depois de cada `step`, o MomAI anexa automaticamente **um frame reduzido** ao seu contexto quando o modelo ativo suporta visão. Use esse frame para decidir se continua, sem salvar print e sem mostrar card no chat. Se o modelo ativo não suporta visão, você recebe um aviso: nesse caso avance às cegas só com `status` (quando a câmera informar) ou peça confirmação ao usuário.
- Para pedidos como "mova até o portão desaparecer": avance em passos, observe o frame anexado (ou peça confirmação) e pare quando o objeto sair do enquadramento. Comece com passos maiores (1500–2500 ms, speed 1.0) para deslocamentos amplos; use 100–500 ms só para ajuste fino. Se o frame mostrar que o enquadramento não mudou após 2 passos, aumente a duração ou pare e avise — não repita o mesmo passo curto em loop. Não repita `show_snapshot` a cada passo.

## Integração com o Automation Hub (Notificações & Ações Externas)

- **REGRA DE OURO PARA O ASSISTENTE (LLM)**:
  - Sempre que o usuário solicitar uma automação, alerta ou notificação envolvendo o MomAI Vision (ex.: avisar, notificar, mandar alerta na tela quando a câmera detectar algo), o assistente **DEVE APENAS CHAMAR A FERRAMENTA `create_automation`** (da skill `automation`).
  - **AÇÃO PADRÃO DE ALERTA**: A ação padrão e preferencial que você deve utilizar é **`momai-vision.show_overlay`** (que abre o card flutuante personalizado do MomAI Vision com a foto limpa capturada, sem caixas por padrão). **NÃO use `system.notify`** a menos que o usuário peça especificamente uma notificação simples do Windows/sistema.
  - Exemplo padrão: `actions: [{ "action_id": "momai-vision.show_overlay", "params": { "cameraId": "{{trigger.payload.cameraId}}", "description": "{{trigger.payload.description}}", "imageDataUri": "{{trigger.payload.imageDataUri}}" } }]`.
  - Se o usuário pedir canais adicionais (ex.: avisar em outro aplicativo), combine a ação `momai-vision.show_overlay` com a ação do canal que ele escolher, sem presumir IDs de outras extensões.
  - **NÃO chame nenhuma ferramenta individual de monitoramento visual antes.** Execute **somente** `create_automation`.

## Triggers (update_monitoring)

```json
{
  "monitorId": "mon-1722880000000",
  "triggers": [{ "type": "motion", "sensitivity": "med" }],
  "schedule": { "days": [0,1,2,3,4,5,6], "start": "22:00", "end": "06:00" },
  "cooldownSec": 300,
  "notify": { "native": true, "chat": true },
  "label": "Garagem"
}
```

- `motion` — movimento (absdiff); `sensitivity`: low/med/high; `minArea`.
- `object` — detecção COCO: `className` (person, cat, dog, car…), `minConfidence`, `present`.
- `presence`/`absence` — `className` (default person), `event`: entered/left/still_present, `windowSec`.
- `cooldownSec` — intervalo mínimo entre alertas do mesmo monitor (padrão 300 = 5min; aceita desde 10s).
- `schedule.days`: 0-6 (domingo=0).

## Edição de Monitoramento (update_monitoring)

Para alterar um monitoramento existente (ex.: "mude o tempo do alerta da garagem para 10 minutos" ou "altere os triggers da câmera da porta"), use `update_monitoring { monitorId: "mon-...", cooldownSec: 600 }`. Use `get_status` caso precise descobrir o `monitorId`.

## Pausar, Retomar e Excluir

- **Pausar** (`pause_monitoring`): o monitoramento para de executar e o card some, mas os dados e a configuração ficam salvos. "pausa o monitoramento da garagem", "para de monitorar por enquanto, mas não exclui".
- **Retomar** (`resume_monitoring`): reativa um monitoramento pausado. "volta a monitorar a garagem".
- **Excluir** (`stop_monitoring`): remove o monitoramento **definitivamente**, incluindo dados/configurações. "exclui o monitoramento da garagem", "quero parar de vez com esse monitoramento". Pausar não é excluir; se o usuário quiser apagar de vez, use `stop_monitoring`.

## Como usar (gramática)

- "o que você vê aí?" → `capture_snapshot` e, em seguida, `show_snapshot` com o `snapshotId` retornado
- "me mostra o último print da garagem" → `show_snapshot` com `cameraId: "garagem"`
- "mova a câmera para a esquerda" → `control_ptz` com `action: "step"`, `direction: "left"` e `durationMs` curto
- "onde a câmera está apontando?" → `control_ptz` com `action: "status"`
- "mova até o portão desaparecer" → passos com `control_ptz` + `status`; sem descrição visual, peça confirmação ao usuário em vez de repetir prints
- "ver as câmeras" → chame `list_cameras` e liste as câmeras disponíveis
- "me avise quando alguém chegar em casa na câmera da garagem" → `create_automation` vinculando `momai-vision.vision_alert` com condição `className: "person"` e ação `momai-vision.show_overlay`
- "mude o intervalo da câmera da garagem para 10 minutos" → `update_monitoring` com `cooldownSec: 600`
- "pausar monitoramento da garagem" → `pause_monitoring`

## Honestidade (limites que a MomAI declara)

- **Identidade**: detecto "uma pessoa", não "quem" (ex.: "meu filho"). Sem reconhecimento facial.
- **Não-visual/oculto**: temperatura, trinco, outro cômodo — não detecto.
- **Transientes curtos**: um passarinho que passa rápido pode não ser captado.
- **Iluminação/clima**: noite sem IR, chuva, reflexos reduzem a qualidade.
- **Geometria/escala**: objeto muito pequeno ou distante não é detectado.
- **PTZ**: consigo mover em passos, ler pan/tilt/zoom quando a câmera expõe `GetStatus` e, com um modelo de visão, ver o frame anexado após cada passo. Sem modelo de visão, não enxergo a cena e preciso da sua confirmação.
- **Subjetivo**: "está arrumado", "está triste" — não consigo avaliar; refinar para uma pergunta verificável.
- "Encomenda/pacote", "porta aberta", "luz acesa" **não são classes COCO** — o monitoramento por objeto cobre apenas as classes suportadas; para esses casos, use `presence`/`absence` de pessoa ou movimento conforme o objetivo.

## Fluxo de monitoramento

1. Para criar uma automação de visão, chame **somente** `create_automation`.
2. Ao disparar um trigger: snapshot salvo na galeria + **overlay flutuante** com a imagem + cartão no chat (`vision_alert`) + entrada no feed de alertas da página.
3. Para pausar (manter salvo): `pause_monitoring {monitorId}` — o overlay e o card somem, mas o monitor continua gerenciável na página. Para retomar depois: `resume_monitoring {monitorId}`.
4. Para excluir de vez (remover dados): `stop_monitoring {monitorId}` — também pela página (botão lixeira) ou pelo overlay.

## Performance

- Orçamento padrão: 1fps por câmera. Com muitas câmeras ativas, o sistema pode reduzir a taxa.
- Motion (gate barato) roda primeiro; a detecção YOLO roda só quando necessário.
- Cooldown/dedupe por monitor evita alertas repetidos.

## Privacidade

- Frames ficam só em memória (nunca em disco).
- Snapshots ficam no diretório local da extensão (7 dias / máx 200 / 100MB, configurável).
- Visão e detecção são 100% locais. Exceção: quando o modelo ativo suporta visão, um frame reduzido do `step` de PTZ é anexado ao modelo (sem salvar na galeria e sem aparecer no chat) para que o assistente veja o resultado do movimento. Sem suporte a visão, o frame é descartado.
