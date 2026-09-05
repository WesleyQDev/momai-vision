# Guia de Automação: MomAI Vision

O MomAI Vision é o motor de percepção visual local do assistente. Ele analisa streams de câmeras e webcams, detecta movimento, presença e objetos (`car`, `person`, `dog`, `cat`, `motorcycle`, etc.) e emite eventos em tempo real.

## Triggers (Gatilhos de Evento)

1. **`momai-vision.vision_alert`**
   - Disparado sempre que um monitor visual detecta um objeto ou evento configurado.
   - **Campos do Payload (`trigger.payload`)**:
     - `cameraName`: Nome da câmera que capturou o evento (ex: `"Garagem"`, `"Portão"`, `"Sala"`)
     - `monitorLabel`: Rótulo do monitor configurado
     - `className`: Classe do objeto detectado em inglês (`person`, `car`, `dog`, `cat`, `motorcycle`, etc.)
     - `description`: Descrição textual do alerta em linguagem natural
     - `imageDataUri`: String base64 com a captura exata (foto) do instante da detecção
     - `ts`: Timestamp numérico do disparo

## Actions (Ações Disponíveis)

1. **`momai-vision.show_overlay` (AÇÃO PADRÃO E PRINCIPAL DE ALERTA)**:
   - Exibe o card flutuante personalizado (overlay) da MomAI Vision na tela com a foto capturada em tempo real e as caixas de detecção (bounding boxes) desenhadas sobre a pessoa ou objeto detectado.
   - **REGRA OBRIGATÓRIA PARA O ASSISTENTE (LLM)**:
     - Sempre que o usuário solicitar para monitorar câmera e "me avise", "notifique", "avise na tela", "mostre o alerta" ou "envie uma notificação", **VOCÊ DEVE INDUZIR E USAR COMO AÇÃO PADRÃO: `momai-vision.show_overlay`**!
     - **NÃO UTILIZE `system.notify`** para regras de visão por padrão! O `system.notify` gera apenas uma notificação genérica de texto do sistema operacional sem imagem. O overlay flutuante (`momai-vision.show_overlay`) é a experiência rica nativa do MomAI Vision. Apenas use `system.notify` se o usuário pedir explicitamente "notificação do windows" ou "notificação simples do sistema".
     - Parâmetros recomendados (todos são opcionais — se omitidos, o overlay recupera automaticamente o snapshot e bounding boxes do alerta mais recente da câmera):
        ```json
        {
          "action_id": "momai-vision.show_overlay",
          "params": {
            "cameraId": "{{trigger.payload.cameraId}}",
            "cameraName": "{{trigger.payload.cameraName}}",
            "description": "{{trigger.payload.description}}"
          }
        }
        ```
        *(Nota: se passar `imageDataUri`, sempre feche com chaves duplas `{{trigger.payload.imageDataUri}}`, mas pode omitir tranquilamente pois o runtime já associa a captura recente automaticamente).*

## Como o Assistente (LLM) Deve Orquestrar Regras de Visão

1. **Ação Padrão vs Outros Canais**:
   - Por padrão, vincule o disparo à ação **`momai-vision.show_overlay`**.
   - Se o usuário pedir expressamente canais adicionais (ex.: "me avise no WhatsApp e mostre o alerta"), adicione múltiplas ações na lista: `momai-vision.show_overlay` E `momai-whatsapp.send_message`.
   - Se o usuário pedir apenas um canal externo específico (ex.: "apenas envie foto no WhatsApp se alguém aparecer"), use a ação daquele canal.

2. **Criação Direta em 1 Passo**:
   - Chame `create_automation` vinculando:
     - `trigger_id`: `"momai-vision.vision_alert"`
     - `global_conditions`:
       - Filtro por tipo de objeto: `[{ "field": "trigger.payload.className", "operator": "equals", "value": "person" }]`
       - *(Opcional)* Filtro por câmera: `[{ "field": "trigger.payload.cameraName", "operator": "contains", "value": "Garagem" }]`
     - `actions`:
       ```json
       [
         {
           "action_id": "momai-vision.show_overlay",
           "params": {
             "cameraId": "{{trigger.payload.cameraId}}",
             "cameraName": "{{trigger.payload.cameraName}}",
             "description": "{{trigger.payload.description}}"
           }
         }
       ]
       ```

3. **Guardrail de Câmeras**:
   - **NÃO chame** `list_cameras`, `get_status` ou `update_monitoring` para criar automações. O Hub de Automações se encarrega de capturar e filtrar os eventos emitidos sem necessidade de intervenção manual nos monitores.

## Tempo de Monitoramento via Automação

O tempo de negócio mora na automação e é propagado para o sensoriamento: `policy.cooldownSeconds` vira o intervalo entre alertas do monitor `auto-` (mínimo 5s; monitores manuais mantêm 10s–3600s) e `weekdays`/`startTime`/`endTime` + condições `time_window` viram a janela de vigilância. Não configure tempo com `update_monitoring` para regras do Hub — configure na automação.

Exemplo (voltar a monitorar depois de 20s): `trigger_id: "momai-vision.vision_alert"` + filtro `className: "person"` + `policy: { "cooldownSeconds": 20 }`.

## Modelo Se-em-lista (Hub de Automações)

- **Vários gatilhos (OU)**: `trigger_ids: ["momai-vision.vision_alert", "<outra_ext>.<evento>"]` — qualquer um dispara. `trigger_configs` leva params por gatilho.
- **Condições (E)** em `global_conditions`, cada uma com `kind`:
  - `"trigger_field"` (padrão): `trigger.payload.<campo>` (ex: `cameraName`, `className`);
  - `"time_window"`: `time.time` (HH:MM, `between`/`equals`), `time.weekday` (`in`, 0=dom–6=sáb), `time.hour`, `time.date`;
  - `"extension_state"`: `extension.<id>.enabled` true/false.
- **Frequência (`policy`)**: `cooldownSeconds` (ex: 20), `maxPerDay`, `weekdays`, `startTime`/`endTime` (HH:MM, suporta 22:00–06:00), `expiresAt`. Omita para executar sempre.
