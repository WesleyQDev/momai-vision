# Guia de Automação: MomAI Vision

## Como Funciona a Automação no MomAI Vision
O MomAI Vision é o motor de percepção visual local. Ele detecta movimento, presença e objetos COCO (`car`, `person`, `dog`, `cat`, `motorcycle`, etc.) e dispara o evento `momai-vision.vision_alert`.

## Passo a Passo para o Assistente (LLM) ao Criar ou Editar Automações
Quando o usuário pedir para ser notificado (no WhatsApp, e-mail, notificação desktop ou som) sobre eventos de câmera:

1. **Criação ou Edição Direta em 1 Passo**: Chame **somente** a ferramenta `create_automation` (ou `update_automation` se estiver editando uma regra existente) vinculando:
   - `trigger_id`: `"momai-vision.vision_alert"`
   - `global_conditions`:
     - Filtro de objeto: `[{ "field": "trigger.payload.className", "operator": "equals", "value": "car" }]`
     - *(Opcional)* Filtro por câmera específica: `[{ "field": "trigger.payload.cameraName", "operator": "contains", "value": "fora" }]`
   - `actions`: `[{ "action_id": "whatsapp.send_message", "params": { "contact": "Nome do contato", "message": "🚗 Carro detectado na câmera {{trigger.payload.cameraName}}!", "image": "{{trigger.payload.imageDataUri}}" } }]`

2. **ATENÇÃO - Não chame ferramentas de câmera**:
   - **NÃO chame** `list_cameras`, `get_status` ou `update_monitoring` para criar ou configurar automações. O Hub de Automações se encarrega de capturar e filtrar os eventos disparados pela visão automaticamente, sem necessidade de intervir nos monitores locais.

## Campos do Payload (`trigger.payload`)
- `cameraName`: Nome da câmera (ex: "Garagem", "casa fora quintal")
- `monitorLabel`: Rótulo do monitor
- `className`: Classe COCO do objeto em inglês (`car`, `person`, `dog`, `cat`, `motorcycle`)
- `description`: Descrição textual do alerta em português
- `imageDataUri`: Imagem em base64 do momento da detecção
- `ts`: Timestamp do disparo
