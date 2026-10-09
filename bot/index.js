import 'dotenv/config';
import crypto from 'node:crypto';
import { Client, Events, GatewayIntentBits } from 'discord.js';

const { DISCORD_TOKEN, APP_URL } = process.env;
if (!DISCORD_TOKEN || !APP_URL) throw new Error('Set DISCORD_TOKEN and APP_URL in .env.');

const baseUrl = APP_URL.replace(/\/$/, '');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, ready => console.log(`Bot conectado como ${ready.user.tag}`));

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'telas') return;

  const room = crypto.randomBytes(9).toString('base64url');
  const name = interaction.options.getString('nome') ?? 'Sala ao vivo';
  const hostUrl = `${baseUrl}/index.html?room=${room}&host=1`;
  const joinUrl = `${baseUrl}/index.html?room=${room}`;

  await interaction.reply({
    ephemeral: true,
    content: `Você é o anfitrião de **${name}**. Abra este link primeiro:\n${hostUrl}\n\nDepois envie o convite abaixo para até 3 amigos.`,
  });

  await interaction.channel?.send({
    content: `**${name}** foi criada por <@${interaction.user.id}>. Entre aqui: ${joinUrl}\n*Abra no navegador, informe seu nome e clique em “Entrar”. Cada pessoa escolhe quando compartilhar a própria tela.*`,
  });
});

client.login(DISCORD_TOKEN);
