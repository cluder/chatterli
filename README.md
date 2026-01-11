# Chatterli - Stream TTS 🇨🇭

**Chatterli** is a real-time Text-to-Speech (TTS) dashboard for Twitch and YouTube streamers. It reads chat messages aloud using high-quality Google Cloud Neural voices or your browser's local TTS engine.

<img width="1148" height="896" alt="image" src="https://github.com/user-attachments/assets/0ec8634b-556a-41f8-8115-5f7020964691" />
 (Example Screenshot)

## ✨ Features

*   **Multi-Platform**: Connect to **Twitch** channels and **YouTube** Live streams simultaneously.
*   **Local TTS**: Uses free, local browser voices to save on API costs and ensure low latency.
*   **Smart Moderation**:
    *   **Blocklist**: Mute specific users temporarily.
    *   **Bot Filtering**: Automatically ignores common bots (Nightbot, StreamElements, etc.).
    *   **Command Filtering**: Ignores messages starting with prefixes like `!`, `/`, `$`.
*   **Bilingual UI**: Fully localized interface in **German** (default) and **English**.
*   **Audio Queue**: Ensures messages are read one by one without overlap.

## 🚀 Quick Start (Local)

1.  **Clone the repository**
    ```bash
    git clone https://github.com/cluder/chatterli.git
    cd chatterli
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Google Cloud Setup (Required for YouTube Chat)**
    *   Create a Google Cloud Project.
    *   **Enable the YouTube Data API v3** (and ostensibly Text-to-Speech API if you plan to use it in the future, though it's disabled in the UI).
    *   Create a Service Account and download the JSON key.
    *   Set the environment variable:
        ```bash
        export GOOGLE_APPLICATION_CREDENTIALS="path/to/credentials.json"
        ```

4.  **Run the Server**
    ```bash
    npm start
    ```
    Open [http://localhost:8080](http://localhost:8080) in your browser.

## ☁️ Deployment (Google Cloud Run)

This project is optimized for **Google Cloud Run**.

1.  **Deploy using gcloud CLI**:
    ```bash
    gcloud run deploy chatterli-tts --source . --region europe-west1 --allow-unauthenticated
    ```

2.  **Environment Variables**:
    *   Ensure your Google Cloud Project has the TTS API enabled. Cloud Run usually handles authentication automatically if deployed in the same project.

## 🛠️ Technology Stack

*   **Backend**: Node.js, Express, Socket.io
*   **APIs**: `tmi.js` (Twitch), `googleapis` (YouTube Data API v3), `@google-cloud/text-to-speech`
*   **Frontend**: HTML5, Vanilla JS, Tailwind CSS
*   **Container**: Docker

## 📝 License

ISC License. See `package.json` for details.
