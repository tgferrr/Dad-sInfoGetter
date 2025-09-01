document.addEventListener('DOMContentLoaded', () => {
    const playersContainer = document.getElementById('playersContainer');
    const checkNowButton = document.getElementById('checkNowButton');
    const resetButton = document.getElementById('resetButton');
    const API_URL = 'http://201.23.67.218:8000/get-users-status';

    const playerIds = ['8631412913', '7738147772', '9005903775'];
    let checkInterval;

    initialize();

    function initialize() {
        initLocalStorage();
        createPlayerCards();
        updateAllDisplays();
        setupEventListeners();
        checkPlayersStatus();
    }

    function initLocalStorage() {
        playerIds.forEach(playerId => {
            if (!localStorage.getItem(`playerSessions_${playerId}`)) {
                localStorage.setItem(`playerSessions_${playerId}`, JSON.stringify([]));
            }
        });
    }

    function createPlayerCards() {
        playerIds.forEach(playerId => {
            const card = document.createElement('div');
            card.className = 'player-card';
            card.id = `player-${playerId}`;
            card.innerHTML = generatePlayerCardHTML(playerId);
            playersContainer.appendChild(card);
        });
    }

    function generatePlayerCardHTML(playerId) {
        return `
            <div class="player-header">
                <div class="player-id">ID: ${playerId}</div>
                <div class="last-checked">Última verificação: -</div>
            </div>
            <div class="status">
                <div id="statusIndicator-${playerId}" class="status-indicator unknown"></div>
                <div id="statusText-${playerId}" class="status-text">Carregando...</div>
            </div>
            <div class="player-info">
                <p><strong>Localização:</strong> <span id="locationText-${playerId}">-</span></p>
                <p><strong>Jogo:</strong> <span id="gameText-${playerId}">-</span></p>
            </div>
            <div class="stats">
                <div class="stat-item">
                    <span>Tempo total online:</span>
                    <span id="totalTime-${playerId}">0 horas</span>
                </div>
                <div class="stat-item">
                    <span>Número de sessões:</span>
                    <span id="sessionCount-${playerId}">0</span>
                </div>
            </div>
            <div class="session-list" id="sessionsList-${playerId}">
                <p>Nenhuma sessão registrada ainda.</p>
            </div>
        `;
    }

    function setupEventListeners() {
        checkNowButton.addEventListener('click', checkPlayersStatus);
        resetButton.addEventListener('click', resetAllHistories);
    }

    async function checkPlayersStatus() {
        try {
            setButtonLoadingState(true);

            const response = await fetch(`${API_URL}?user_ids=${playerIds.join('%2C')}`);
            if (!response.ok) throw new Error(`Erro HTTP: ${response.status}`);

            const playersData = await response.json();
            updatePlayersData(playersData);
        } catch (error) {
            console.error('Erro ao verificar status:', error);
            displayConnectionError();
        } finally {
            setButtonLoadingState(false);
        }
    }

    function setButtonLoadingState(isLoading) {
        checkNowButton.disabled = isLoading;
        checkNowButton.innerHTML = isLoading
            ? '<span class="loading"></span> Verificando...'
            : 'Verificar Agora';
    }

    function updatePlayersData(playersData) {
        playerIds.forEach(playerId => {
            const playerData = playersData.find(user => user.userId === playerId);
            if (playerData) {
                updatePlayerStatus(playerId, playerData);
            } else {
                updatePlayerError(playerId, 'Jogador não encontrado');
            }
        });
    }

    function resetAllHistories() {
        if (confirm('Tem certeza que deseja limpar todo o histórico de todos os jogadores?')) {
            playerIds.forEach(playerId => {
                localStorage.setItem(`playerSessions_${playerId}`, JSON.stringify([]));
            });
            updateAllDisplays();
        }
    }

    function displayConnectionError() {
        playerIds.forEach(playerId => {
            updatePlayerError(playerId, 'Erro de conexão');
        });
    }

    function updateAllDisplays() {
        playerIds.forEach(updatePlayerDisplay);
    }
});