const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const tmi = require('tmi.js');
const { LiveChat } = require('youtube-chat');
const textToSpeech = require('@google-cloud/text-to-speech');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const ttsClient = new textToSpeech.TextToSpeechClient();

app.use(express.static('public'));

// --- Konfiguration ---
let globalBlockedUsers = new Set(['streamlabs', 'nightbot', 'moobot', 'streamelements']);
const blockedPrefixes = ['!', '/', '$'];

// 'local' bedeutet: Der Server sendet KEIN Audio, der Browser nutzt window.speechSynthesis
const ALLOWED_VOICES = [
    'local', 
    'de-DE-Neural2-F',
    'de-DE-Neural2-B',
    'en-US-Neural2-C',
    'en-US-Neural2-D'
];

io.on('connection', (socket) => {
    console.log('Chatterli Client verbunden:', socket.id);
    
    // Standard: Google TTS
    let currentVoice = 'de-DE-Neural2-F'; 
    
    let twitchClient = null;
    let youtubeChat = null;

    socket.emit('blocklist_update', Array.from(globalBlockedUsers));

    // --- STIMME ÄNDERN ---
    socket.on('change_voice', (voiceId) => {
        // Wir erlauben 'local' oder eine der Google IDs
        if (ALLOWED_VOICES.includes(voiceId)) {
            currentVoice = voiceId;
            console.log(`Stimme für ${socket.id} geändert auf: ${voiceId}`);
        }
    });

    // --- TWITCH ---
    socket.on('join_twitch', (channel) => {
        if (!channel) return;
        if (twitchClient) twitchClient.disconnect();
        
        twitchClient = new tmi.Client({ channels: [channel] });
        twitchClient.connect().then(() => {
            socket.emit('system_msg', `Verbunde mit Twitch: ${channel}`);
        }).catch(err => socket.emit('system_msg', `Twitch Fehler: ${err}`));

        twitchClient.on('message', (chan, tags, message, self) => {
            if (self) return;
            processMessage('twitch', tags['display-name'], message, socket, currentVoice);
        });
    });

    // --- YOUTUBE ---
    socket.on('join_youtube', async (id) => {
        if (!id) return;
        if (youtubeChat) youtubeChat.stop();

        youtubeChat = new LiveChat({ channelId: id });
        youtubeChat.on('chat', (item) => {
            const user = item.author.name;
            const message = item.message.map(m => m.text).join('');
            processMessage('youtube', user, message, socket, currentVoice);
        });

        const ok = await youtubeChat.start();
        socket.emit('system_msg', ok ? `YouTube Chat aktiv` : `YouTube Stream ned gfunge.`);
    });

    socket.on('mute_user', (user) => {
        globalBlockedUsers.add(user.toLowerCase());
        io.emit('blocklist_update', Array.from(globalBlockedUsers));
    });

    socket.on('unmute_user', (user) => {
        globalBlockedUsers.delete(user.toLowerCase());
        io.emit('blocklist_update', Array.from(globalBlockedUsers));
    });

    socket.on('disconnect', () => {
        if (twitchClient) twitchClient.disconnect();
        if (youtubeChat) youtubeChat.stop();
    });
});

async function processMessage(platform, user, text, socket, voiceId) {
    const lowUser = user.toLowerCase();
    
    if (globalBlockedUsers.has(lowUser)) return;
    if (blockedPrefixes.some(p => text.startsWith(p))) return;

    console.log(`Verarbeite (${voiceId}): ${user}: ${text}`);

    try {
        let audioBase64 = null;

        // Nur Audio generieren, wenn NICHT 'local' ausgewählt ist
        if (voiceId !== 'local') {
            const langCode = voiceId.split('-').slice(0, 2).join('-');
            const request = {
                input: { text: `${user}: ${text}` },
                voice: { languageCode: langCode, name: voiceId },
                audioConfig: { audioEncoding: 'MP3', pitch: 0, speakingRate: 1.1 },
            };
            const [response] = await ttsClient.synthesizeSpeech(request);
            audioBase64 = response.audioContent.toString('base64');
        }

        socket.emit('chat_message', {
            platform,
            user,
            text,
            audio: audioBase64, // Ist null bei 'local'
            id: Date.now()
        });
    } catch (err) {
        console.error('TTS Fehler:', err);
    }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Chatterli läuft auf Port ${PORT}`));