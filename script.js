const TRANSLATIONS = {
    en: {
        no_input: "NO INPUT",
        select_audio: "SELECT AUDIO",
        play: "PLAY",
        pause: "PAUSE",
        resume: "RESUME",
        stop: "STOP",
        dimension: "DIMENSION",
        bass_intensity: "BASS INTENSITY",
        export: "EXPORT",
        render: "RENDER",
        download: "DOWNLOAD",
        history_btn: "HISTORY LIST",
        history_title: "HISTORY",
        no_history: "NO HISTORY",
        rendering: "RENDERING...",
        ready_render: "READY TO RENDER",
        load_failed: "LOAD FAILED",
        ready: "READY",
        loading: "LOADING...",
        render_failed: "RENDER FAILED",
        play_history: "PLAY",
        dl_history: "DL"
    },
    ja: {
        no_input: "入力なし",
        select_audio: "音声を選択",
        play: "再生",
        pause: "一時停止",
        resume: "再開",
        stop: "停止",
        dimension: "空間効果",
        bass_intensity: "低音強度",
        export: "書き出し",
        render: "レンダリング",
        download: "保存",
        history_btn: "履歴リスト",
        history_title: "履歴",
        no_history: "履歴なし",
        rendering: "処理中...",
        ready_render: "準備完了",
        load_failed: "読込失敗",
        ready: "準備OK",
        loading: "読込中...",
        render_failed: "失敗",
        play_history: "再生",
        dl_history: "保存"
    }
};

class LanguageManager {
    constructor() {
        this.lang = localStorage.getItem('quake_lang') || 'en';
        this.toggleBtn = document.getElementById('lang-toggle');
        this.updateUI();
        
        this.toggleBtn.addEventListener('click', () => {
            this.lang = this.lang === 'en' ? 'ja' : 'en';
            localStorage.setItem('quake_lang', this.lang);
            this.updateUI();
        });
    }

    t(key) {
        return TRANSLATIONS[this.lang][key] || key;
    }

    updateUI() {
        document.documentElement.lang = this.lang;
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (TRANSLATIONS[this.lang][key]) {
                el.textContent = TRANSLATIONS[this.lang][key];
            }
        });
        
        // Update button text manually if needed, or by logic
        // But the button text 'JP / EN' is static.
        // Update dynamic texts if they are currently displayed
        const statusText = document.getElementById('status-text');
        if (statusText && !statusText.hasAttribute('data-i18n')) {
             // Handle dynamic status updates? 
             // Ideally the main app asks LangManager for strings.
        }
    }
}

class HistoryManager {
    constructor(onUpdate) {
        this.dbName = 'QuakeHistoryDB';
        this.storeName = 'recordings';
        this.onUpdate = onUpdate;
        this.db = null;
        this.init();
    }

    init() {
        const request = indexedDB.open(this.dbName, 1);
        
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(this.storeName)) {
                const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                store.createIndex('date', 'date', { unique: false });
            }
        };

        request.onsuccess = (e) => {
            this.db = e.target.result;
            this.loadHistory();
        };
    }

    async addRecord(blob, filename) {
        if (!this.db) return;
        
        const record = {
            id: Date.now(),
            date: new Date(),
            name: filename,
            blob: blob
        };

        const tx = this.db.transaction([this.storeName], 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.add(record);

        // Limit to 100
        const countReq = store.count();
        countReq.onsuccess = () => {
            if (countReq.result > 100) {
                // Delete oldest
                // We need to fetch keys sorted by id (time)
                const keyTx = this.db.transaction([this.storeName], 'readwrite');
                const keyStore = keyTx.objectStore(this.storeName);
                const cursorReq = keyStore.openCursor(); // direction next = oldest first
                let deleted = 0;
                const toDelete = countReq.result - 100;
                
                cursorReq.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor && deleted < toDelete) {
                        cursor.delete();
                        deleted++;
                        cursor.continue();
                    }
                };
            }
        };

        tx.oncomplete = () => {
            this.loadHistory();
        };
    }

    loadHistory() {
        if (!this.db) return;
        
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.getAll();
        
        req.onsuccess = () => {
            // Sort by date desc
            const items = req.result.sort((a, b) => b.id - a.id);
            if (this.onUpdate) this.onUpdate(items);
        };
    }
}

class QuakeAudio {
    constructor() {
        this.audioCtx = null;
        this.sourceNode = null;
        this.audioElement = null;
        this.loadedArrayBuffer = null;
        this.gainNode = null;
        this.pannerNode = null;
        this.bassFilter = null;
        this.analyser = null;
        this.isPlaying = false;
        this.animationId = null;
        
        // Spatial State
        this.spatialMode = 'off';
        this.panAngle = 0;
        
        // DOM Elements
        this.visualizerCanvas = document.getElementById('visualizer');
        this.canvasCtx = this.visualizerCanvas.getContext('2d');
        this.statusText = document.getElementById('status-text');
        this.renderBtn = document.getElementById('render-btn');
        this.downloadLink = document.getElementById('download-link');
        this.renderBtn = document.getElementById('render-btn');
        this.downloadLink = document.getElementById('download-link');
        this.exportStatus = document.getElementById('export-status');
        
        // Managers
        this.langManager = new LanguageManager();
        this.historyManager = new HistoryManager((items) => this.renderHistory(items));

        // History UI
        this.historyModal = document.getElementById('history-modal');
        this.historyList = document.getElementById('history-list');
        document.getElementById('history-toggle-btn').addEventListener('click', () => {
            this.historyModal.classList.add('visible');
            this.historyManager.loadHistory();
        });
        document.getElementById('close-history').addEventListener('click', () => {
            this.historyModal.classList.remove('visible');
        });
        // Click outside to close
        this.historyModal.addEventListener('click', (e) => {
            if (e.target === this.historyModal) this.historyModal.classList.remove('visible');
        });

        this.initListeners();
        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
    }

    initAudioContext() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
    }

    initListeners() {
        // File Upload
        document.getElementById('audio-upload').addEventListener('change', (e) => this.handleFileUpload(e));
        
        // Playback
        document.getElementById('play-btn').addEventListener('click', () => this.play());
        document.getElementById('stop-btn').addEventListener('click', () => this.stop());

        // Export
        this.renderBtn.addEventListener('click', () => this.renderAndPrepareDownload());
        this.downloadLink.addEventListener('click', (e) => {
            if (this.downloadLink.getAttribute('aria-disabled') === 'true') {
                e.preventDefault();
            }
        });
        
        // Spatial Controls
        document.querySelectorAll('input[name="spatial"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.spatialMode = e.target.value;
                // Reset pan when turning off
                if (this.spatialMode === 'off' && this.pannerNode) {
                    this.pannerNode.pan.value = 0;
                }
            });
        });
        
        // Bass Controls
        document.querySelectorAll('input[name="bass"]').forEach(radio => {
            radio.addEventListener('change', (e) => this.setBass(e.target.value));
        });
    }

    resizeCanvas() {
        const container = this.visualizerCanvas.parentElement;
        this.visualizerCanvas.width = container.clientWidth;
        this.visualizerCanvas.height = container.clientHeight;
    }

    handleFileUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        document.getElementById('file-name').textContent = file.name;
        document.getElementById('file-name').textContent = file.name;
        document.getElementById('status-text').textContent = this.langManager.t("loading");
        this.exportStatus.textContent = "...";
        this.disableDownload();
        
        // Stop previous
        if (this.isPlaying) this.stop();

        // Create Audio Element
        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement = null;
        }

        this.audioElement = new Audio(URL.createObjectURL(file));
        this.audioElement.loop = true;

        file.arrayBuffer().then((ab) => {
            this.loadedArrayBuffer = ab;
            this.loadedArrayBuffer = ab;
            this.renderBtn.disabled = false;
            this.exportStatus.textContent = this.langManager.t("ready_render");
        }).catch(() => {
            this.loadedArrayBuffer = null;
            this.renderBtn.disabled = true;
            this.exportStatus.textContent = this.langManager.t("load_failed");
        });
        
        // Enable Controls
        document.getElementById('play-btn').disabled = false;
        document.getElementById('stop-btn').disabled = false;
        
        document.getElementById('play-btn').disabled = false;
        document.getElementById('stop-btn').disabled = false;
        
        document.getElementById('status-text').textContent = this.langManager.t("ready");
    }

    disableDownload() {
        this.downloadLink.href = '#';
        this.downloadLink.setAttribute('aria-disabled', 'true');
    }

    enableDownload(objectUrl, suggestedName) {
        this.downloadLink.href = objectUrl;
        this.downloadLink.download = suggestedName;
        this.downloadLink.setAttribute('aria-disabled', 'false');
    }

    getCurrentSettings() {
        const spatial = document.querySelector('input[name="spatial"]:checked')?.value || 'off';
        const bass = document.querySelector('input[name="bass"]:checked')?.value || 'off';
        return { spatial, bass };
    }

    getBassGainDb(mode) {
        switch (mode) {
            case 'off': return 0;
            case 'low': return 5;
            case 'medium': return 10;
            case 'high': return 15;
            case 'extra': return 20;
            case 'earthquake': return 40;
            default: return 0;
        }
    }

    getPanSpeed(mode) {
        switch (mode) {
            case '8d': return 0.005;
            case '16d': return 0.015;
            case '32d': return 0.03;
            case '48d': return 0.06;
            default: return 0;
        }
    }

    buildSuggestedFilename() {
        const { spatial, bass } = this.getCurrentSettings();
        const d = spatial.toUpperCase();
        const b = bass.toUpperCase();
        return `quake1_${d}_${b}.wav`;
    }

    async renderAndPrepareDownload() {
        if (!this.loadedArrayBuffer) return;

        this.renderBtn.disabled = true;
        this.exportStatus.textContent = this.langManager.t("rendering");
        this.disableDownload();

        try {
            const { spatial, bass } = this.getCurrentSettings();

            const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
            const decoded = await tmpCtx.decodeAudioData(this.loadedArrayBuffer.slice(0));
            await tmpCtx.close();

            // Limit render duration to avoid huge files; looped feel is achieved by rendering N seconds.
            const renderSeconds = Math.min(120, Math.max(10, Math.ceil(decoded.duration)));
            const sampleRate = decoded.sampleRate;
            const frameCount = Math.floor(sampleRate * renderSeconds);

            const offline = new OfflineAudioContext(decoded.numberOfChannels, frameCount, sampleRate);
            const src = offline.createBufferSource();
            src.buffer = decoded;
            src.loop = true;

            const bassFilter = offline.createBiquadFilter();
            bassFilter.type = 'lowshelf';
            bassFilter.frequency.value = 200;
            bassFilter.gain.value = this.getBassGainDb(bass);

            const panner = offline.createStereoPanner();
            panner.pan.value = 0;

            src.connect(bassFilter).connect(panner).connect(offline.destination);

            // Automation for spatial
            if (spatial !== 'off') {
                const speed = this.getPanSpeed(spatial);
                const step = 1 / 60;
                let t = 0;
                let angle = 0;
                while (t <= renderSeconds) {
                    angle += speed;
                    let pan = Math.sin(angle);
                    if (spatial === '48d') {
                        pan = Math.sin(angle) * Math.cos(angle * 0.5);
                    }
                    panner.pan.setValueAtTime(pan, t);
                    t += step;
                }
            }

            src.start(0);
            const renderedBuffer = await offline.startRendering();

            const wavBlob = this.audioBufferToWavBlob(renderedBuffer);
            const url = URL.createObjectURL(wavBlob);
            this.enableDownload(url, this.buildSuggestedFilename());

            this.exportStatus.textContent = `READY (${renderSeconds}s WAV)`;
            
            // Save to history
            this.historyManager.addRecord(wavBlob, this.buildSuggestedFilename());

        } catch (err) {
            console.error(err);
            this.exportStatus.textContent = this.langManager.t("render_failed");
        } finally {
            this.renderBtn.disabled = false;
        }
    }

    audioBufferToWavBlob(audioBuffer) {
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const format = 1; // PCM
        const bitDepth = 16;

        const length = audioBuffer.length;
        const interleaved = new Float32Array(length * numChannels);

        for (let ch = 0; ch < numChannels; ch++) {
            const channelData = audioBuffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                interleaved[i * numChannels + ch] = channelData[i];
            }
        }

        const bytesPerSample = bitDepth / 8;
        const blockAlign = numChannels * bytesPerSample;
        const buffer = new ArrayBuffer(44 + interleaved.length * bytesPerSample);
        const view = new DataView(buffer);

        const writeString = (offset, str) => {
            for (let i = 0; i < str.length; i++) {
                view.setUint8(offset + i, str.charCodeAt(i));
            }
        };

        let offset = 0;
        writeString(offset, 'RIFF'); offset += 4;
        view.setUint32(offset, 36 + interleaved.length * bytesPerSample, true); offset += 4;
        writeString(offset, 'WAVE'); offset += 4;
        writeString(offset, 'fmt '); offset += 4;
        view.setUint32(offset, 16, true); offset += 4;
        view.setUint16(offset, format, true); offset += 2;
        view.setUint16(offset, numChannels, true); offset += 2;
        view.setUint32(offset, sampleRate, true); offset += 4;
        view.setUint32(offset, sampleRate * blockAlign, true); offset += 4;
        view.setUint16(offset, blockAlign, true); offset += 2;
        view.setUint16(offset, bitDepth, true); offset += 2;
        writeString(offset, 'data'); offset += 4;
        view.setUint32(offset, interleaved.length * bytesPerSample, true); offset += 4;

        let idx = 0;
        while (idx < interleaved.length) {
            let sample = interleaved[idx++];
            sample = Math.max(-1, Math.min(1, sample));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }

    setupAudioGraph() {
        this.initAudioContext();
        
        // Cleanup old nodes if needed
        if (this.sourceNode) {
            this.sourceNode.disconnect();
        }

        // Create Source
        this.sourceNode = this.audioCtx.createMediaElementSource(this.audioElement);
        
        // Create Nodes
        this.gainNode = this.audioCtx.createGain();
        this.pannerNode = this.audioCtx.createStereoPanner();
        this.bassFilter = this.audioCtx.createBiquadFilter();
        this.analyser = this.audioCtx.createAnalyser();
        
        // Configure Analyser
        this.analyser.fftSize = 256;

        // Configure Bass Filter (LowShelf)
        this.bassFilter.type = 'lowshelf';
        this.bassFilter.frequency.value = 200; // Bass frequency
        this.bassFilter.gain.value = 0;

        // Connect Graph: Source -> Bass -> Panner -> Gain -> Analyser -> Destination
        this.sourceNode
            .connect(this.bassFilter)
            .connect(this.pannerNode)
            .connect(this.gainNode)
            .connect(this.analyser)
            .connect(this.audioCtx.destination);
            
        // Apply current bass setting
        const currentBass = document.querySelector('input[name="bass"]:checked').value;
        this.setBass(currentBass);
    }

    play() {
        if (!this.audioElement) return;
        
        if (!this.sourceNode) {
            this.setupAudioGraph();
        }

        this.audioCtx.resume().then(() => {
            this.audioElement.play();
            this.isPlaying = true;
            this.statusText.style.display = 'none';
            document.getElementById('play-btn').textContent = this.langManager.t("pause");
            
            // Start loops
            this.animate();
        });
        
        // Toggle play/pause logic
        document.getElementById('play-btn').onclick = () => {
            if (this.audioElement.paused) {
                this.audioElement.play();
                this.isPlaying = true;
                this.statusText.style.display = 'none';
                document.getElementById('play-btn').textContent = "PAUSE";
            } else {
                this.audioElement.pause();
                this.isPlaying = false;
                this.statusText.style.display = 'block';
                this.statusText.textContent = "PAUSED";
                document.getElementById('play-btn').textContent = this.langManager.t("resume");
            }
        };
    }

    stop() {
        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.currentTime = 0;
            this.isPlaying = false;
            this.audioElement.currentTime = 0;
            this.isPlaying = false;
            document.getElementById('play-btn').textContent = this.langManager.t("play");
            this.statusText.style.display = 'block';
            this.statusText.textContent = "STOPPED";
            
            // Reset handler
            document.getElementById('play-btn').onclick = () => this.play();
        }
        if (this.pannerNode) {
            this.pannerNode.pan.value = 0;
        }
    }

    setBass(mode) {
        if (!this.bassFilter) return;

        // Transition gain smoothly
        const currentTime = this.audioCtx.currentTime;
        this.bassFilter.gain.cancelScheduledValues(currentTime);
        
        let gainValue = 0;
        
        switch (mode) {
            case 'off': gainValue = 0; break;
            case 'low': gainValue = 5; break;
            case 'medium': gainValue = 10; break;
            case 'high': gainValue = 15; break;
            case 'extra': gainValue = 20; break;
            case 'earthquake': gainValue = 40; break; // Extreme
        }

        this.bassFilter.gain.linearRampToValueAtTime(gainValue, currentTime + 0.5);
    }

    animate() {
        if (!this.isPlaying) {
            requestAnimationFrame(() => this.animate());
            return;
        }

        // 1. Handle Visualizer
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        this.analyser.getByteFrequencyData(dataArray);

        const canvas = this.visualizerCanvas;
        const ctx = this.canvasCtx;
        const width = canvas.width;
        const height = canvas.height;

        ctx.clearRect(0, 0, width, height);

        const barWidth = (width / bufferLength) * 2.5;
        let barHeight;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            barHeight = dataArray[i] / 2; // Scale down

            // Nothing OS Style: Red bars
            ctx.fillStyle = '#d71921'; // Nothing Red
            
            // Draw bar
            ctx.fillRect(x, height - barHeight, barWidth, barHeight);

            x += barWidth + 1;
        }

        // 2. Handle Spatial Audio Panning
        if (this.pannerNode && this.spatialMode !== 'off') {
            this.handleSpatialEffect();
        }

        requestAnimationFrame(() => this.animate());
    }

    handleSpatialEffect() {
        // Increment angle
        let speed = 0.01; // Base speed
        
        switch (this.spatialMode) {
            case '8d': speed = 0.005; break; // Slow circle
            case '16d': speed = 0.015; break; // Faster
            case '32d': speed = 0.03; break; // Fast
            case '48d': speed = 0.06; break; // Super Fast
        }

        this.panAngle += speed;
        
        // Circular panning: sin wave for left-right
        // Math.sin(angle) goes from -1 to 1
        let panValue = Math.sin(this.panAngle);
        
        // Apply to panner
        this.pannerNode.pan.value = panValue;
        
        // 48D (SSS) extra modulation: Volume dip when "behind" (simulated)
        // Cosine can simulate Z-axis (front/back). 
        // When cos is negative (behind), we might slightly muffle or lower volume?
        // For simplicity, just crazy panning for now.
        
        if (this.spatialMode === '48d') {
             // Add jitter or complex modulation
             this.pannerNode.pan.value = Math.sin(this.panAngle) * Math.cos(this.panAngle * 0.5);
        }
    }

    renderHistory(items) {
        this.historyList.innerHTML = '';
        if (items.length === 0) {
            this.historyList.innerHTML = `<div class="empty-msg" data-i18n="no_history">${this.langManager.t("no_history")}</div>`;
            return;
        }

        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'history-item';
            
            const dateStr = item.date.toLocaleString();
            
            div.innerHTML = `
                <div class="history-info">
                    <div class="history-name" title="${item.name}">${item.name}</div>
                    <div class="history-meta">${dateStr}</div>
                </div>
                <div class="history-actions">
                    <button class="history-btn play-hist-btn" data-i18n="play_history">${this.langManager.t("play_history")}</button>
                    <button class="history-btn dl-hist-btn" data-i18n="dl_history">${this.langManager.t("dl_history")}</button>
                </div>
            `;
            
            // Play Button
            div.querySelector('.play-hist-btn').addEventListener('click', () => {
                this.loadBlob(item.blob, item.name);
                this.historyModal.classList.remove('visible');
            });
            
            // Download Button
            div.querySelector('.dl-hist-btn').addEventListener('click', () => {
                const url = URL.createObjectURL(item.blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = item.name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            });

            this.historyList.appendChild(div);
        });
    }

    loadBlob(blob, name) {
        // Reuse handleFileUpload logic but with a blob
        document.getElementById('file-name').textContent = name;
        document.getElementById('status-text').textContent = this.langManager.t("loading");
        this.exportStatus.textContent = "...";
        this.disableDownload();
        
        if (this.isPlaying) this.stop();

        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement = null;
        }

        this.audioElement = new Audio(URL.createObjectURL(blob));
        this.audioElement.loop = true;

        blob.arrayBuffer().then((ab) => {
            this.loadedArrayBuffer = ab;
            this.renderBtn.disabled = false;
            this.exportStatus.textContent = this.langManager.t("ready_render");
        }).catch(() => {
            this.loadedArrayBuffer = null;
            this.renderBtn.disabled = true;
            this.exportStatus.textContent = this.langManager.t("load_failed");
        });
        
        document.getElementById('play-btn').disabled = false;
        document.getElementById('stop-btn').disabled = false;
        
        document.getElementById('status-text').textContent = this.langManager.t("ready");
    }
}

// Initialize
window.addEventListener('DOMContentLoaded', () => {
    new QuakeAudio();
});
