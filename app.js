const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const isHost = params.get('host') === '1';
const maxParticipants = 12;
// PeerJS aceita somente IDs alfanuméricos de forma consistente. Mantemos o código
// visível da sala, mas o convertemos deterministicamente para a sinalização.
const peerRoomId = roomId
  ? `r${Array.from(new TextEncoder().encode(roomId)).map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  : undefined;

const ui = {
  joinCard: document.querySelector('#join-card'), room: document.querySelector('#room'), name: document.querySelector('#name'),
  join: document.querySelector('#join'), share: document.querySelector('#share'), leave: document.querySelector('#leave'),
  quality: document.querySelector('#quality'), status: document.querySelector('#status'), notice: document.querySelector('#notice'), joinError: document.querySelector('#join-error'),
  screens: document.querySelector('#screens'), count: document.querySelector('#participant-count'), roomLabel: document.querySelector('#room-label'),
  grid: document.querySelector('#grid'), layoutHint: document.querySelector('#layout-hint'), hiddenLives: document.querySelector('#hidden-lives'),
  template: document.querySelector('#screen-template'),
};

let peer, localId, localName, screenStream, hostConnection, hostRetries = 0, roomJoined = false, hostRetryTimer, signallingRetries = 0, signalRecoveryTimer, signalRecoveryAttempts = 0;
const people = new Map(); // peerId -> display name
const calls = new Map(); // `${direction}:${peerId}` -> media call
const remoteStreams = new Map();
const callRetries = new Map();
const connections = new Map(); // only host needs these to announce membership
let streamOrder = [];
let focusedPeerId;
const hiddenPeerIds = new Set();
const mediaPreferences = new Map();

function setStatus(text, problem = false) { ui.status.textContent = text; ui.status.classList.toggle('problem', problem); }
function notify(text) { ui.notice.textContent = text; ui.joinError.textContent = text; }
function hostId() { return `${peerRoomId}h`; }
function personName(id) { return people.get(id) ?? (id === localId ? localName : 'Amigo'); }
function preferencesFor(id) {
  if (!mediaPreferences.has(id)) mediaPreferences.set(id, { muted: id === localId, volume: 1 });
  return mediaPreferences.get(id);
}

function syncStreamOrder() {
  const active = [...people.keys()];
  streamOrder = [...streamOrder.filter(id => active.includes(id)), ...active.filter(id => !streamOrder.includes(id))];
  if (focusedPeerId && !active.includes(focusedPeerId)) focusedPeerId = undefined;
  [...hiddenPeerIds].filter(id => !active.includes(id)).forEach(id => hiddenPeerIds.delete(id));
  if (focusedPeerId && hiddenPeerIds.has(focusedPeerId)) focusedPeerId = undefined;
}

function moveStream(id, direction) {
  const index = streamOrder.indexOf(id);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= streamOrder.length) return;
  [streamOrder[index], streamOrder[destination]] = [streamOrder[destination], streamOrder[index]];
  render();
}

function toggleFocus(id) {
  focusedPeerId = focusedPeerId === id ? undefined : id;
  render();
}

function renderHiddenLives() {
  const hidden = streamOrder.filter(id => hiddenPeerIds.has(id));
  ui.hiddenLives.hidden = hidden.length === 0;
  ui.hiddenLives.replaceChildren();
  hidden.forEach(id => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'restore-live';
    button.textContent = `Mostrar ${personName(id)}`;
    button.addEventListener('click', () => { hiddenPeerIds.delete(id); render(); });
    ui.hiddenLives.append(button);
  });
}

function render() {
  syncStreamOrder();
  ui.screens.replaceChildren();
  ui.screens.classList.toggle('focus-mode', Boolean(focusedPeerId));
  ui.grid.setAttribute('aria-pressed', String(!focusedPeerId));
  ui.grid.textContent = focusedPeerId ? 'Voltar à grade' : 'Grade';
  ui.layoutHint.textContent = focusedPeerId ? `Foco em ${personName(focusedPeerId)}` : 'Escolha uma live para focar';
  renderHiddenLives();
  streamOrder.forEach((id, index) => {
    if (hiddenPeerIds.has(id)) return;
    const item = ui.template.content.firstElementChild.cloneNode(true);
    item.dataset.peerId = id;
    item.classList.toggle('focused', focusedPeerId === id);
    item.classList.add('visible');
    item.querySelector('strong').textContent = id === localId ? `${personName(id)} (você)` : personName(id);
    item.querySelector('.fullscreen').addEventListener('click', () => item.requestFullscreen?.());
    const focus = item.querySelector('.focus');
    focus.setAttribute('aria-pressed', String(focusedPeerId === id));
    focus.setAttribute('aria-label', focusedPeerId === id ? 'Voltar à grade' : 'Focar transmissão');
    focus.dataset.tooltip = focusedPeerId === id ? 'Voltar à grade' : 'Focar';
    focus.addEventListener('click', () => toggleFocus(id));
    const video = item.querySelector('video');
    const preference = preferencesFor(id);
    video.muted = preference.muted;
    video.volume = preference.volume;
    const mute = item.querySelector('.mute');
    const updateMute = () => {
      mute.setAttribute('aria-pressed', String(preference.muted));
      mute.setAttribute('aria-label', preference.muted ? 'Ativar som da transmissão' : 'Silenciar transmissão');
      mute.dataset.tooltip = preference.muted ? 'Ativar som' : 'Silenciar';
    };
    updateMute();
    mute.addEventListener('click', () => {
      preference.muted = !preference.muted;
      video.muted = preference.muted;
      updateMute();
      video.play().catch(() => {});
    });
    const volume = item.querySelector('.volume');
    volume.value = String(Math.round(preference.volume * 100));
    volume.addEventListener('input', () => {
      preference.volume = Number(volume.value) / 100;
      video.volume = preference.volume;
      if (preference.volume > 0 && preference.muted && id !== localId) preference.muted = false;
      video.muted = preference.muted;
      updateMute();
    });
    item.querySelector('.hide').addEventListener('click', () => { hiddenPeerIds.add(id); render(); });
    item.querySelector('.up').addEventListener('click', () => moveStream(id, -1));
    item.querySelector('.down').addEventListener('click', () => moveStream(id, 1));
    item.querySelector('.up').disabled = index === 0;
    item.querySelector('.down').disabled = index === streamOrder.length - 1;
    ui.screens.append(item);
    const stream = id === localId ? screenStream : remoteStreams.get(id);
    if (stream) setVideo(id, stream, false);
  });
  ui.count.textContent = `${people.size} de ${maxParticipants} participantes`;
}

function setVideo(id, stream, remember = true) {
  if (remember && id !== localId) remoteStreams.set(id, stream);
  const video = document.querySelector(`[data-peer-id="${CSS.escape(id)}"] video`);
  if (!video) return;
  video.srcObject = stream;
  const preference = preferencesFor(id);
  video.muted = preference.muted;
  video.volume = preference.volume;
  video.play().catch(() => {});
  video.closest('.screen').classList.add('active');
  video.closest('.screen').querySelector('.screen-state').textContent = 'Ao vivo';
}

function closeCall(id) {
  ['out', 'in'].forEach(direction => {
    const key = `${direction}:${id}`;
    calls.get(key)?.close();
    calls.delete(key);
  });
}

function callPeer(id) {
  const key = `out:${id}`;
  if (!screenStream || id === localId || calls.has(key)) return;
  const call = peer.call(id, screenStream, { metadata: { name: localName } });
  calls.set(key, call);
  call.on('close', () => {
    calls.delete(key);
    retryCall(id);
  });
  call.on('error', () => {
    calls.delete(key);
    retryCall(id);
  });
}

function retryCall(id) {
  const retries = callRetries.get(id) || 0;
  if (screenStream && people.has(id) && retries < 5) {
    callRetries.set(id, retries + 1);
    setTimeout(() => callPeer(id), 1000 + retries * 500);
  }
}

function callEveryone() { [...people.keys()].forEach(callPeer); }

function announcePeers() {
  if (!isHost) return;
  const payload = { type: 'peers', people: [...people.entries()] };
  connections.forEach(connection => connection.open && connection.send(payload));
}

function connectToHost() {
  if (isHost || roomJoined || hostRetries >= 15) {
    if (!roomJoined && hostRetries >= 15) {
      setStatus('Anfitrião indisponível', true);
      notify('O anfitrião ainda não abriu o link privado. Peça para ele entrar primeiro e tente novamente.');
    }
    return;
  }

  hostRetries += 1;
  setStatus(`Procurando anfitrião… (${hostRetries}/15)`);
  hostConnection = peer.connect(hostId(), { reliable: true });
  // Keep polling even when a failed connection does not emit every PeerJS event.
  scheduleHostRetry();
  let opened = false;

  hostConnection.on('open', () => {
    opened = true;
    roomJoined = true;
    setStatus('Conectado à sala');
    hostConnection.send({ type: 'hello', name: localName });
  });
  hostConnection.on('data', data => {
    if (data?.type === 'room-full') {
      roomJoined = false;
      notify(`A sala já chegou ao limite de ${maxParticipants} pessoas.`);
      hostConnection.close();
      return;
    }
    if (data?.type !== 'peers') return;
    people.clear();
    data.people.forEach(([id, name]) => people.set(id, name));
    people.set(localId, localName);
    render();
    if (screenStream) callEveryone();
  });
  hostConnection.on('error', retry);
  hostConnection.on('close', () => {
    if (!opened && !roomJoined) retry();
  });

  function retry() { scheduleHostRetry(opened); }
}

function scheduleHostRetry(opened = false) {
  if (opened || roomJoined || isHost || hostRetryTimer || hostRetries >= 15) return;
  hostRetryTimer = setTimeout(() => {
    hostRetryTimer = undefined;
    connectToHost();
  }, 1000);
}

function recoverSignalling(candidate) {
  if (candidate !== peer || candidate.destroyed || signalRecoveryTimer || signalRecoveryAttempts >= 5) return;
  signalRecoveryAttempts += 1;
  setStatus(`Recuperando conexão P2P… (${signalRecoveryAttempts}/5)`);
  notify('A conexão de sinalização caiu; reconectando sem interromper os compartilhamentos atuais.');
  candidate.reconnect();
  signalRecoveryTimer = setTimeout(() => {
    signalRecoveryTimer = undefined;
    if (candidate === peer && !candidate.open) recoverSignalling(candidate);
  }, 1400);
}

function acceptConnection(connection) {
  connection.on('data', data => {
    if (data?.type !== 'hello') return;
    if (isHost && people.size >= maxParticipants && !people.has(connection.peer)) {
      connection.send({ type: 'room-full' }); connection.close(); return;
    }
    people.set(connection.peer, data.name?.slice(0, 24) || 'Amigo');
    connections.set(connection.peer, connection);
    render(); announcePeers();
  });
  connection.on('close', () => {
    if (!isHost) return;
    connections.delete(connection.peer); people.delete(connection.peer); remoteStreams.delete(connection.peer); closeCall(connection.peer); render(); announcePeers();
  });
}

function receiveCall(call) {
  call.answer();
  const key = `in:${call.peer}`;
  calls.set(key, call);
  if (!people.has(call.peer)) { people.set(call.peer, call.metadata?.name || 'Amigo'); render(); }
  call.on('stream', stream => setVideo(call.peer, stream));
  call.on('close', () => { calls.delete(key); remoteStreams.delete(call.peer); render(); });
}

async function startSharing() {
  const [heightValue, fpsValue] = ui.quality.value.split('-');
  const height = Number(heightValue);
  const fps = Number(fpsValue);
  if (!navigator.mediaDevices?.getDisplayMedia) {
    notify('Este navegador permite assistir, mas não oferece compartilhamento de tela. Em celulares, essa função depende do navegador e do sistema.');
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: height === 1080 ? 1920 : 1280 }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } },
      audio: true,
    });
    setVideo(localId, screenStream);
    ui.share.textContent = 'Parar compartilhamento';
    notify(`Transmitindo em até ${height}p / ${fps} fps. A qualidade real varia com a tela e a conexão.`);
    screenStream.getVideoTracks()[0].addEventListener('ended', stopSharing, { once: true });
    callEveryone();
  } catch (error) {
    if (error.name !== 'NotAllowedError') notify(`Não foi possível iniciar a captura: ${error.message}`);
  }
}

function stopSharing() {
  screenStream?.getTracks().forEach(track => track.stop()); screenStream = undefined;
  [...calls.entries()].filter(([key]) => key.startsWith('out:')).forEach(([key, call]) => { call.close(); calls.delete(key); });
  const card = document.querySelector(`[data-peer-id="${CSS.escape(localId)}"]`);
  if (card) { card.querySelector('video').srcObject = null; card.classList.remove('active'); }
  ui.share.textContent = 'Compartilhar minha tela'; notify('Seu compartilhamento foi encerrado.');
}

function startPeer() {
  const candidate = new Peer(localId); // Usa o PeerJS Cloud apenas para sinalização; mídia permanece P2P.
  peer = candidate;
  let opened = false;
  candidate.on('open', () => {
    if (candidate !== peer) return;
    opened = true;
    signalRecoveryAttempts = 0;
    clearTimeout(signalRecoveryTimer); signalRecoveryTimer = undefined;
    people.set(localId, localName); render();
    ui.joinCard.hidden = true; ui.room.hidden = false; ui.roomLabel.textContent = `Sala ${roomId.slice(0, 6)}`;
    setStatus(isHost ? 'Sala aberta — aguardando amigos' : 'Conectado à sala');
    if (isHost) announcePeers(); else connectToHost();
    if (screenStream) callEveryone();
  });
  candidate.on('connection', acceptConnection);
  candidate.on('call', receiveCall);
  candidate.on('disconnected', () => { if (opened) recoverSignalling(candidate); });
  candidate.on('error', error => {
    if (candidate !== peer) return;
    if (!isHost && !roomJoined && (error.type === 'peer-unavailable' || /Could not connect to peer/.test(error.message))) {
      setStatus(`Procurando anfitrião… (${hostRetries}/15)`);
      scheduleHostRetry();
      return;
    }
    if (opened && ['network', 'socket-error', 'server-error'].includes(error.type)) {
      recoverSignalling(candidate);
      return;
    }
    if (!opened && error.type !== 'unavailable-id' && signallingRetries < 3) {
      signallingRetries += 1;
      setStatus(`Reconectando à sinalização… (${signallingRetries}/3)`);
      notify('A conexão inicial falhou; tentando novamente automaticamente.');
      peer = undefined;
      candidate.destroy();
      setTimeout(() => { if (!peer) startPeer(); }, 1200);
      return;
    }
    setStatus('Falha de conexão', true);
    ui.join.disabled = false;
    notify(error.type === 'unavailable-id'
      ? 'Esta sala já está aberta em outra aba ou navegador. Feche a outra aba e tente novamente.'
      : `Não foi possível conectar à sinalização P2P (${error.type || 'rede'}). Verifique bloqueadores/VPN e tente novamente.`);
  });
}

async function join() {
  if (!roomId) { setStatus('Link inválido: falta o identificador da sala.', true); return; }
  localName = ui.name.value.trim() || 'Amigo';
  localId = isHost ? hostId() : `${peerRoomId}g${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  signallingRetries = 0;
  ui.joinError.textContent = '';
  ui.join.disabled = true; setStatus('Conectando à sinalização…');
  startPeer();
}

ui.join.addEventListener('click', join);
ui.name.addEventListener('keydown', event => { if (event.key === 'Enter') join(); });
ui.share.addEventListener('click', () => screenStream ? stopSharing() : startSharing());
ui.grid.addEventListener('click', () => { focusedPeerId = undefined; render(); });
ui.leave.addEventListener('click', () => { stopSharing(); peer?.destroy(); location.href = 'about:blank'; });
if (!roomId) setStatus('Abra o link recebido pelo Discord.', true);
if (!navigator.mediaDevices?.getDisplayMedia) {
  ui.share.disabled = true;
  ui.share.title = 'Este navegador não oferece compartilhamento de tela.';
}
