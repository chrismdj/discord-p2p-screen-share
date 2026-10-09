const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const isHost = params.get('host') === '1';
const maxParticipants = 4;

const ui = {
  joinCard: document.querySelector('#join-card'), room: document.querySelector('#room'), name: document.querySelector('#name'),
  join: document.querySelector('#join'), share: document.querySelector('#share'), leave: document.querySelector('#leave'),
  quality: document.querySelector('#quality'), status: document.querySelector('#status'), notice: document.querySelector('#notice'), joinError: document.querySelector('#join-error'),
  screens: document.querySelector('#screens'), count: document.querySelector('#participant-count'), roomLabel: document.querySelector('#room-label'),
  template: document.querySelector('#screen-template'),
};

let peer, localId, localName, screenStream, hostConnection, hostRetries = 0, roomJoined = false, hostRetryTimer, signallingRetries = 0;
const people = new Map(); // peerId -> display name
const calls = new Map(); // `${direction}:${peerId}` -> media call
const remoteStreams = new Map();
const connections = new Map(); // only host needs these to announce membership

function setStatus(text, problem = false) { ui.status.textContent = text; ui.status.classList.toggle('problem', problem); }
function notify(text) { ui.notice.textContent = text; ui.joinError.textContent = text; }
function hostId() { return `${roomId}-host`; }
function personName(id) { return people.get(id) ?? (id === localId ? localName : 'Amigo'); }

function render() {
  ui.screens.replaceChildren();
  [...people.keys()].forEach(id => {
    const item = ui.template.content.firstElementChild.cloneNode(true);
    item.dataset.peerId = id;
    item.querySelector('strong').textContent = id === localId ? `${personName(id)} (você)` : personName(id);
    item.querySelector('.fullscreen').addEventListener('click', () => item.requestFullscreen?.());
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
  video.closest('.screen').classList.add('active');
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
  call.on('close', () => calls.delete(key));
  call.on('error', () => calls.delete(key));
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
      notify('A sala já chegou ao limite de quatro pessoas.');
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
  const height = Number(ui.quality.value);
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: height === 1080 ? 1920 : 1280 }, height: { ideal: height }, frameRate: { ideal: 30, max: 30 } },
      audio: true,
    });
    setVideo(localId, screenStream);
    ui.share.textContent = 'Parar compartilhamento';
    notify(`Transmitindo em até ${height}p / 30 fps. A qualidade real varia com a tela e a conexão.`);
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
    people.set(localId, localName); render();
    ui.joinCard.hidden = true; ui.room.hidden = false; ui.roomLabel.textContent = `Sala ${roomId.slice(0, 6)}`;
    setStatus(isHost ? 'Sala aberta — aguardando amigos' : 'Conectado à sala');
    if (isHost) return;
    connectToHost();
  });
  candidate.on('connection', acceptConnection);
  candidate.on('call', receiveCall);
  candidate.on('error', error => {
    if (candidate !== peer) return;
    if (!isHost && !roomJoined && (error.type === 'peer-unavailable' || /Could not connect to peer/.test(error.message))) {
      setStatus(`Procurando anfitrião… (${hostRetries}/15)`);
      scheduleHostRetry();
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
  localId = isHost ? hostId() : `${roomId}-${crypto.randomUUID().slice(0, 8)}`;
  signallingRetries = 0;
  ui.joinError.textContent = '';
  ui.join.disabled = true; setStatus('Conectando à sinalização…');
  startPeer();
}

ui.join.addEventListener('click', join);
ui.name.addEventListener('keydown', event => { if (event.key === 'Enter') join(); });
ui.share.addEventListener('click', () => screenStream ? stopSharing() : startSharing());
ui.leave.addEventListener('click', () => { stopSharing(); peer?.destroy(); location.href = 'about:blank'; });
if (!roomId) setStatus('Abra o link recebido pelo Discord.', true);
