# MAIA KARAOKÊ — versão 2.0

Aplicação Node.js com painel administrativo, páginas públicas de fila, QR Code individual, filas separadas por evento, cronômetro persistido no servidor, chamada por voz no navegador, tela de TV para YouTube e criação de painéis extras.

## Requisitos
- Node.js 20+
- Hospedagem que execute aplicações Node.js continuamente
- HTTPS para uso público recomendado/necessário para recursos modernos do navegador
- Disco persistente para SQLite (ou migração para PostgreSQL em hospedagem efêmera)

## Instalação local
1. Extraia o ZIP.
2. Copie `.env.example` para `.env`.
3. Configure `MASTER_PASSWORD` com uma senha forte (mínimo recomendado 12 caracteres), `SESSION_SECRET` com segredo aleatório longo e `BASE_URL` com o domínio real.
4. `npm install`
5. `npm start`
6. Abra `http://localhost:3000`.

O login master é `fabricio` por padrão. A senha é definida no `.env`. Não existe senha fixa gravada no código.

## Deploy
Publique em um host Node.js que mantenha processo e armazenamento persistente. Configure as variáveis de ambiente do `.env.example` no painel do host, defina `BASE_URL` para o domínio HTTPS e execute `npm install && npm start`. Não use hospedagem somente estática.

## Recursos
- Fila independente por painel; participantes entram por `/fila/ID`.
- Painel administrativo por `/painel/ID`.
- Painel principal `/` e ID `main`.
- QR Code individual por `/api/qr/ID`.
- Cronômetro com estado e término persistidos no servidor.
- Seleção de música sincronizada com tela `/musica/ID`.
- Criação de painel extra com data, hora, duração e tolerância.
- WhatsApp abre mensagem preenchida; o usuário precisa confirmar o envio.
- Master cria usuários; os usuários recebem senha com hash bcrypt.

## Limites que exigem contratação/credenciais externas
- PIX: a chave cadastrada é exibida/copied; confirmação automática de pagamento exige integração com um PSP (Mercado Pago, Efí, PagBank etc.), credenciais de API, webhook e ambiente de produção. Não marque pagamento como recebido apenas por este protótipo.
- WhatsApp: `wa.me` abre conversa e texto; envio automático requer WhatsApp Business Platform e credenciais aprovadas.
- YouTube: vídeos podem bloquear incorporação/autoplay por decisão do canal/YouTube; nesses casos, abra o link do vídeo diretamente no YouTube.
- Áudio: a voz é sintetizada no navegador do painel; depende do dispositivo e permissões.
- Para múltiplas instâncias em produção, troque SQLite e sessões locais por PostgreSQL + Redis/adapter Socket.IO.
- Configure backups, HTTPS, política de privacidade, proteção contra abuso/rate limiting e testes de carga antes de uso comercial.

## Publicação guiada no Render
O projeto inclui `render.yaml` para criar um serviço Node.js com disco persistente (necessário para preservar filas, usuários e sessões SQLite entre reinicializações). Ao criar o serviço, informe uma senha master forte em `MASTER_PASSWORD`; o login inicial continua `fabricio`. O Render gera `SESSION_SECRET` automaticamente. Depois do primeiro deploy, copie o endereço HTTPS do serviço para `BASE_URL` se necessário; na ausência dessa variável o app usa `RENDER_EXTERNAL_URL` automaticamente.

**Atenção:** o plano Starter é pago e o valor final deve ser conferido na tela de contratação do Render. O disco persistente também pode ter cobrança própria. Não selecione plano gratuito para operar um evento ao vivo com persistência SQLite: o serviço gratuito pode suspender e não oferece disco persistente adequado a este projeto.
