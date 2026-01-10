const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require("socket.io");
const tmi = require('tmi.js');
const { google } = require('googleapis');
const textToSpeech = require('@google-cloud/text-to-speech');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const ttsClient = new textToSpeech.TextToSpeechClient();

// YouTube Data API Setup
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const youtube = google.youtube({
    version: 'v3',
    auth: YOUTUBE_API_KEY,
    headers: {
        'Referer': 'https://chatterli-tts-984890422608.europe-west1.run.app'
    }
});

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
    let youtubePollingInterval = null;
    let lastMessageId = null;

    socket.emit('blocklist_update', Array.from(globalBlockedUsers));

    // --- STIMME ÄNDERN ---
    socket.on('change_voice', (voiceId) => {
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
            socket.emit('system_msg', `Verbunden mit Twitch: ${channel}`);
            socket.emit('twitch_connected', channel);
        }).catch(err => socket.emit('system_msg', `Twitch Fehler: ${err}`));

        twitchClient.on('message', (chan, tags, message, self) => {
            if (self) return;
            processMessage('twitch', tags['display-name'], message, socket, currentVoice);
        });
    });

    socket.on('leave_twitch', () => {
        if (twitchClient) {
            twitchClient.disconnect();
            twitchClient = null;
            socket.emit('system_msg', 'Twitch Verbindung getrennt.');
            socket.emit('twitch_disconnected');
        }
    });

    // --- YOUTUBE (Official API) ---
    socket.on('join_youtube', async (id) => {
        if (!id) return;

        // Stoppe vorheriges Polling
        if (youtubePollingInterval) {
            clearInterval(youtubePollingInterval);
            youtubePollingInterval = null;
        }
        lastMessageId = null;

        if (!YOUTUBE_API_KEY) {
            socket.emit('system_msg', 'YouTube Fehler: API Key nicht konfiguriert');
            return;
        }

        try {
            // Löse die Video ID auf (Handle -> Video ID)
            const videoId = await resolveToVideoId(id);
            if (!videoId) {
                socket.emit('system_msg', 'Konnte keine Live-Video ID finden. Bitte Video ID direkt eingeben.');
                return;
            }

            console.log(`Video ID aufgelöst: ${id} -> ${videoId}`);

            // Hole die Live Chat ID vom Video
            const liveChatId = await getLiveChatId(videoId);
            if (!liveChatId) {
                socket.emit('system_msg', 'Kein aktiver Live Chat gefunden für dieses Video.');
                return;
            }

            console.log(`Live Chat ID gefunden: ${liveChatId}`);
            socket.emit('system_msg', `YouTube Chat verbunden (Video: ${videoId})`);
            socket.emit('youtube_connected', videoId);

            // Starte Polling für Chat Messages
            let pageToken = null;
            let pollingIntervalMs = 5000; // Start mit 5 Sekunden
            const connectionStartTime = Date.now(); // Zeitpunkt der Verbindung

            const pollChat = async () => {
                try {
                    const response = await youtube.liveChatMessages.list({
                        liveChatId: liveChatId,
                        part: 'snippet,authorDetails',
                        pageToken: pageToken,
                        maxResults: 200
                    });

                    const messages = response.data.items || [];
                    pageToken = response.data.nextPageToken;
                    pollingIntervalMs = response.data.pollingIntervalMillis || 5000;

                    for (const msg of messages) {
                        // 1. Prüfe ob die Nachricht schon verarbeitet wurde (ID Check)
                        if (lastMessageId && msg.id === lastMessageId) continue;

                        // 2. ZEIT-CHECK: Ignoriere alte Nachrichten
                        // snippet.publishedAt ist ein ISO String (z.B. "2026-01-10T12:00:00Z")
                        const msgTime = new Date(msg.snippet.publishedAt).getTime();

                        // Wenn die Nachricht älter ist als die Verbindung => Ignorieren
                        if (msgTime < connectionStartTime) {
                            console.log(`Ignoriere alte Nachricht von ${msg.authorDetails.displayName} (${msg.snippet.publishedAt})`);
                            continue;
                        }
                        const user = msg.authorDetails.displayName;
                        const text = msg.snippet.displayMessage || msg.snippet.textMessageDetails?.messageText || '';

                        if (text) {
                            processMessage('youtube', user, text, socket, currentVoice);
                        }
                    }

                    if (messages.length > 0) {
                        lastMessageId = messages[messages.length - 1].id;
                    }

                } catch (err) {
                    console.error('YouTube Chat Poll Fehler:', err.message);
                    if (err.code === 403) {
                        socket.emit('system_msg', 'YouTube API Quota erschöpft oder Zugriff verweigert.');
                        clearInterval(youtubePollingInterval);
                    } else if (err.code === 404) {
                        socket.emit('system_msg', 'Live Chat nicht mehr verfügbar (Stream beendet?).');
                        clearInterval(youtubePollingInterval);
                    }
                }
            };

            // Erste Abfrage sofort, dann im Intervall
            await pollChat();
            youtubePollingInterval = setInterval(pollChat, pollingIntervalMs);

        } catch (err) {
            console.error('YouTube Verbindungsfehler:', err);
            socket.emit('system_msg', `YouTube Fehler: ${err.message}`);
        }
    });

    socket.on('leave_youtube', () => {
        if (youtubePollingInterval) {
            clearInterval(youtubePollingInterval);
            youtubePollingInterval = null;
            socket.emit('system_msg', 'YouTube Verbindung getrennt.');
            socket.emit('youtube_disconnected');
        }
    });

    // Löst Handle/Channel zu Video ID auf
    async function resolveToVideoId(input) {
        // Bereits eine Video ID? (11 Zeichen, kein @, kein UC)
        if (input.length === 11 && !input.startsWith('@') && !input.startsWith('UC')) {
            return input;
        }

        // Handle -> Video ID via Scraping
        const handle = input.startsWith('@') ? input : (input.startsWith('UC') ? null : `@${input}`);

        if (handle) {
            try {
                const liveUrl = `https://www.youtube.com/${handle}/live`;
                console.log(`Lade Live-Seite: ${liveUrl}`);
                const liveHtml = await fetchUrl(liveUrl);

                const videoIdMatch = liveHtml.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
                if (videoIdMatch) {
                    console.log(`Video ID gefunden: ${videoIdMatch[1]}`);
                    return videoIdMatch[1];
                }
            } catch (e) {
                console.error('Handle Auflösung fehlgeschlagen:', e.message);
            }
        }

        // Channel ID -> Suche nach aktivem Live Stream via API
        if (input.startsWith('UC')) {
            try {
                const searchResponse = await youtube.search.list({
                    channelId: input,
                    part: 'id',
                    eventType: 'live',
                    type: 'video',
                    maxResults: 1
                });

                if (searchResponse.data.items && searchResponse.data.items.length > 0) {
                    return searchResponse.data.items[0].id.videoId;
                }
            } catch (e) {
                console.error('Channel Live-Suche fehlgeschlagen:', e.message);
            }
        }

        return null;
    }

    // Holt die Live Chat ID für ein Video
    async function getLiveChatId(videoId) {
        try {
            const response = await youtube.videos.list({
                id: videoId,
                part: 'liveStreamingDetails'
            });

            if (response.data.items && response.data.items.length > 0) {
                return response.data.items[0].liveStreamingDetails?.activeLiveChatId;
            }
        } catch (err) {
            console.error('getLiveChatId Fehler:', err.message);
        }
        return null;
    }

    function fetchUrl(url, maxRedirects = 5) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const protocol = urlObj.protocol === 'https:' ? https : http;

            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
                }
            };

            console.log(`Fetching URL: ${url}`);

            protocol.get(options, (res) => {
                console.log(`Response status: ${res.statusCode}`);

                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (maxRedirects <= 0) {
                        reject(new Error('Too many redirects'));
                        return;
                    }
                    const redirectUrl = res.headers.location.startsWith('http')
                        ? res.headers.location
                        : `https://www.youtube.com${res.headers.location}`;
                    console.log(`Redirecting to: ${redirectUrl}`);
                    fetchUrl(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
                    return;
                }

                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    console.log(`Received ${data.length} bytes`);
                    resolve(data);
                });
            }).on('error', (err) => {
                console.error(`Fetch error: ${err.message}`);
                reject(err);
            });
        });
    }

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
        if (youtubePollingInterval) clearInterval(youtubePollingInterval);
    });

    socket.on('disconnect_channels', () => {
        if (twitchClient) {
            twitchClient.disconnect();
            twitchClient = null;
            socket.emit('twitch_disconnected');
        }
        if (youtubePollingInterval) {
            clearInterval(youtubePollingInterval);
            youtubePollingInterval = null;
            socket.emit('youtube_disconnected');
        }
        socket.emit('system_msg', 'Alle Verbindungen getrennt und TTS gestoppt.');
    });
});

async function processMessage(platform, user, text, socket, voiceId) {
    const lowUser = user.toLowerCase();

    if (globalBlockedUsers.has(lowUser)) return;
    if (blockedPrefixes.some(p => text.startsWith(p))) return;

    console.log(`Verarbeite (${voiceId}): ${user}: ${text}`);

    try {
        let audioBase64 = null;

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
            audio: audioBase64,
            id: Date.now()
        });
    } catch (err) {
        console.error('TTS Fehler:', err);
    }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Chatterli läuft auf Port ${PORT}`));