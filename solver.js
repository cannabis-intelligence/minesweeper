// ==UserScript==
// @name         minesweeper
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Powered by cannabis intelligence
// @author       je
// @match        https://minesweeper.online/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    var solving = false;
    var watching = false;
    var stepCount = 0;
    var guessCount = 0;
    var processedCells = {};
    var lastActionTime = 0;
    var ACTION_DELAY = 250;
    var WATCH_INTERVAL = 0;

    // --- Game State ---

    var lastGameState = null;

    function isGameOver() {
        var face = document.getElementById('top_area_face');
        if (face) {
            var cls = face.className || '';
            if (cls.indexOf('hdn_top-area-face-lose') !== -1) return 'lost';
            if (cls.indexOf('hdn_top-area-face-win') !== -1) return 'won';
        }

        var faceEls = document.querySelectorAll('[class*="top-area-face"]');
        for (var i = 0; i < faceEls.length; i++) {
            var cls2 = faceEls[i].className || '';
            if (cls2.indexOf('hdn_top-area-face-lose') !== -1) return 'lost';
            if (cls2.indexOf('hdn_top-area-face-win') !== -1) return 'won';
        }

        if (document.querySelectorAll('.cell.hdn_mine').length > 0) return 'lost';

        return null;
    }

    function detectNewGame() {
        var gs = isGameOver();
        if (gs && !lastGameState) {
            lastGameState = gs;
        } else if (!gs && lastGameState) {
            lastGameState = null;
            resetState();
            clearOverlays();
            setStatus('Ready', '#00ff9d');
        }
    }

    // --- Grid ---

    function getCellSize() {
        var cell = document.querySelector('.cell');
        if (cell) {
            var r = cell.getBoundingClientRect();
            if (r.width > 0) return r.width;
        }
        return 44;
    }

    function getCells() {
        var cells = document.querySelectorAll('.cell');
        if (cells.length === 0) return null;

        var grid = {}, maxCol = 0, maxRow = 0;

        cells.forEach(function(cell) {
            var m = cell.id.match(/cell_(\d+)_(\d+)/);
            if (!m) return;
            var col = parseInt(m[1]), row = parseInt(m[2]);
            if (col > maxCol) maxCol = col;
            if (row > maxRow) maxRow = row;

            var cls = cell.className;
            var state = 'closed', value = -1;

            if (cls.indexOf('hdn_flag') !== -1) state = 'flagged';
            else if (cls.indexOf('hdn_mine') !== -1) state = 'mine';
            else if (cls.indexOf('hdn_opened') !== -1) {
                state = 'opened';
                for (var i = 0; i <= 8; i++) {
                    if (cls.indexOf('hdn_type' + i) !== -1) { value = i; break; }
                }
            }

            grid[col + ',' + row] = { el: cell, state: state, value: value, col: col, row: row };
        });

        return { grid: grid, cols: maxCol + 1, rows: maxRow + 1 };
    }

    function getNeighbors(grid, col, row, cols, rows) {
        var result = [];
        for (var dc = -1; dc <= 1; dc++) {
            for (var dr = -1; dr <= 1; dr++) {
                if (dc === 0 && dr === 0) continue;
                var nc = col + dc, nr = row + dr;
                if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) {
                    var key = nc + ',' + nr;
                    if (grid[key]) result.push(grid[key]);
                }
            }
        }
        return result;
    }

    // --- Set Helpers ---

    function cellKey(c) { return c.col + ',' + c.row; }

    function makeCellSet(cells) {
        var s = {};
        for (var i = 0; i < cells.length; i++) s[cellKey(cells[i])] = cells[i];
        return s;
    }

    function setDiff(aSet, bSet) {
        var result = [];
        var keys = Object.keys(aSet);
        for (var i = 0; i < keys.length; i++) {
            if (!bSet[keys[i]]) result.push(aSet[keys[i]]);
        }
        return result;
    }

    function setIntersect(aSet, bSet) {
        var result = [];
        var keys = Object.keys(aSet);
        for (var i = 0; i < keys.length; i++) {
            if (bSet[keys[i]]) result.push(aSet[keys[i]]);
        }
        return result;
    }

    function setContains(aSet, cell) {
        return !!aSet[cellKey(cell)];
    }

    // --- Analysis ---

    function analyze() {
        var data = getCells();
        if (!data) return null;

        var grid = data.grid, cols = data.cols, rows = data.rows;
        var safeSet = {}, knownMinesSet = {};

        // Detect total mine count
        var totalMines = -1;
        var mineCounter = document.querySelector('#top_area_mines, .mines-count, [class*="mines"]');
        if (mineCounter) {
            var num = parseInt(mineCounter.textContent);
            if (!isNaN(num)) totalMines = num;
        }

        function buildConstraints() {
            var constraints = [];
            for (var r = 0; r < rows; r++) {
                for (var c = 0; c < cols; c++) {
                    var cell = grid[c + ',' + r];
                    if (!cell || cell.state !== 'opened' || cell.value <= 0) continue;

                    var neighbors = getNeighbors(grid, c, r, cols, rows);
                    var closedSet = {}, flaggedCount = 0;

                    for (var i = 0; i < neighbors.length; i++) {
                        var n = neighbors[i];
                        var nk = cellKey(n);
                        if (n.state === 'flagged' || knownMinesSet[nk]) flaggedCount++;
                        else if (n.state === 'closed' && !knownMinesSet[nk] && !safeSet[nk]) {
                            closedSet[nk] = n;
                        }
                    }

                    var remaining = cell.value - flaggedCount;
                    var closedCells = [];
                    var cKeys = Object.keys(closedSet);
                    for (var j = 0; j < cKeys.length; j++) closedCells.push(closedSet[cKeys[j]]);

                    if (closedCells.length > 0) {
                        constraints.push({ cells: closedCells, cellSet: closedSet, remaining: remaining });
                    }
                }
            }
            return constraints;
        }

        // Multi-pass constraint propagation
        var maxPasses = 50;
        for (var pass = 0; pass < maxPasses; pass++) {
            var constraints = buildConstraints();
            var changed = false;

            // Pass 1: Basic rules
            for (var ci = 0; ci < constraints.length; ci++) {
                var con = constraints[ci];
                if (Object.keys(con.cellSet).length === 0) continue;

                if (con.remaining === 0) {
                    var sKeys = Object.keys(con.cellSet);
                    for (var j = 0; j < sKeys.length; j++) {
                        if (!safeSet[sKeys[j]]) { safeSet[sKeys[j]] = con.cellSet[sKeys[j]]; changed = true; }
                    }
                    con.cellSet = {};
                    con.cells = [];
                    continue;
                }

                if (con.remaining === con.cells.length) {
                    for (var m = 0; m < con.cells.length; m++) {
                        var mk = cellKey(con.cells[m]);
                        if (!knownMinesSet[mk]) { knownMinesSet[mk] = con.cells[m]; changed = true; }
                    }
                    con.cellSet = {};
                    con.cells = [];
                    con.remaining = 0;
                    continue;
                }
            }

            // Pass 2: Generalized subset subtraction
            for (var ci2 = 0; ci2 < constraints.length; ci2++) {
                var A = constraints[ci2];
                if (Object.keys(A.cellSet).length === 0) continue;

                for (var oi = 0; oi < constraints.length; oi++) {
                    if (ci2 === oi) continue;
                    var B = constraints[oi];
                    if (Object.keys(B.cellSet).length === 0) continue;

                    // Check if A.cells is subset of B.cells
                    var aKeys = Object.keys(A.cellSet);
                    var isSubset = true;
                    for (var sk = 0; sk < aKeys.length; sk++) {
                        if (!B.cellSet[aKeys[sk]]) { isSubset = false; break; }
                    }

                    if (isSubset && aKeys.length > 0) {
                        var diffCells = setDiff(B.cellSet, A.cellSet);
                        var diff = B.remaining - A.remaining;

                        if (diff === 0 && diffCells.length > 0) {
                            for (var d = 0; d < diffCells.length; d++) {
                                var dk = cellKey(diffCells[d]);
                                if (!safeSet[dk]) { safeSet[dk] = diffCells[d]; changed = true; }
                            }
                        } else if (diff === diffCells.length && diff > 0) {
                            for (var d2 = 0; d2 < diffCells.length; d2++) {
                                var dk2 = cellKey(diffCells[d2]);
                                if (!knownMinesSet[dk2]) { knownMinesSet[dk2] = diffCells[d2]; changed = true; }
                            }
                        }
                    }
                }
            }

            if (!changed) break;
        }

        // Convert safeSet to array, filter unprocessed
        var safeArr = [];
        var sKeys = Object.keys(safeSet);
        for (var si = 0; si < sKeys.length; si++) {
            if (!processedCells[sKeys[si]]) safeArr.push(safeSet[sKeys[si]]);
        }

        // Get remaining closed cells
        var closedCells = [], closedCount = 0;
        var gKeys = Object.keys(grid);
        for (var k = 0; k < gKeys.length; k++) {
            if (grid[gKeys[k]].state === 'closed') {
                closedCount++;
                if (!processedCells[gKeys[k]]) closedCells.push(grid[gKeys[k]]);
            }
        }

        return { safe: safeArr, closed: closedCells, closedCount: closedCount, knownMines: knownMinesSet };
    }

    // --- Exact Solver (fallback for guessing) ---

    function exactSolve(closedCells, grid, cols, rows) {
        // Build constraints as arrays of cell keys
        var constraints = [];
        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                var cell = grid[c + ',' + r];
                if (!cell || cell.state !== 'opened' || cell.value <= 0) continue;

                var neighbors = getNeighbors(grid, c, r, cols, rows);
                var closed = [], flaggedCount = 0;

                for (var i = 0; i < neighbors.length; i++) {
                    var n = neighbors[i];
                    if (n.state === 'flagged') flaggedCount++;
                    else if (n.state === 'closed') closed.push(n);
                }

                var remaining = cell.value - flaggedCount;
                if (closed.length > 0 && remaining >= 0) {
                    constraints.push({ keys: closed.map(cellKey), remaining: remaining });
                }
            }
        }

        if (constraints.length === 0 || closedCells.length === 0) return null;
        if (closedCells.length > 50) return null; // Too expensive

        // Map each closed cell to index
        var cellIndex = {};
        for (var i = 0; i < closedCells.length; i++) cellIndex[cellKey(closedCells[i])] = i;

        // Filter constraints to only reference cells in closedCells
        var validConstraints = [];
        for (var ci = 0; ci < constraints.length; ci++) {
            var con = constraints[ci];
            var mappedKeys = [];
            var valid = true;
            for (var ki = 0; ki < con.keys.length; ki++) {
                if (cellIndex[con.keys[ki]] !== undefined) {
                    mappedKeys.push(cellIndex[con.keys[ki]]);
                }
            }
            if (mappedKeys.length > 0 && con.remaining <= mappedKeys.length) {
                validConstraints.push({ indices: mappedKeys, remaining: con.remaining });
            }
        }

        if (validConstraints.length === 0) return null;

        var n = closedCells.length;
        var mineCounts = new Array(n);
        var totalValid = 0;

        // Brute-force with backtracking
        var assignment = new Array(n);

        function checkConstraints(depth) {
            for (var ci = 0; ci < validConstraints.length; ci++) {
                var con = validConstraints[ci];
                var mineCount = 0;
                var unknownCount = 0;
                for (var ii = 0; ii < con.indices.length; ii++) {
                    var idx = con.indices[ii];
                    if (idx < depth) {
                        if (assignment[idx] === 1) mineCount++;
                    } else {
                        unknownCount++;
                    }
                }
                // Too many mines already
                if (mineCount > con.remaining) return false;
                // Even if all unknowns are mines, not enough
                if (mineCount + unknownCount < con.remaining) return false;
            }
            return true;
        }

        function enumerate(depth) {
            if (depth === n) {
                // Check all constraints satisfied
                for (var ci = 0; ci < validConstraints.length; ci++) {
                    var con = validConstraints[ci];
                    var mineCount = 0;
                    for (var ii = 0; ii < con.indices.length; ii++) {
                        if (assignment[con.indices[ii]] === 1) mineCount++;
                    }
                    if (mineCount !== con.remaining) return;
                }
                totalValid++;
                for (var i = 0; i < n; i++) {
                    if (assignment[i] === 1) mineCounts[i] = (mineCounts[i] || 0) + 1;
                }
                return;
            }

            for (var val = 0; val <= 1; val++) {
                assignment[depth] = val;
                if (checkConstraints(depth + 1)) {
                    enumerate(depth + 1);
                }
            }
        }

        enumerate(0);

        if (totalValid === 0) return null;

        // Return probabilities
        var result = [];
        for (var i = 0; i < n; i++) {
            result.push({ cell: closedCells[i], prob: (mineCounts[i] || 0) / totalValid });
        }
        return result;
    }

    function pickBestGuess(closedCells, grid, cols, rows) {
        if (!closedCells.length) return null;

        // Try exact solver first (if board is small enough)
        if (closedCells.length <= 50) {
            var exactResult = exactSolve(closedCells, grid, cols, rows);
            if (exactResult) {
                exactResult.sort(function(a, b) { return a.prob - b.prob; });
                return exactResult[0].cell;
            }
        }

        // Fallback: approximate probability using constraints
        var constraints = [];
        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                var cell = grid[c + ',' + r];
                if (!cell || cell.state !== 'opened' || cell.value <= 0) continue;

                var neighbors = getNeighbors(grid, c, r, cols, rows);
                var closed = [], flaggedCount = 0;

                for (var i = 0; i < neighbors.length; i++) {
                    var n = neighbors[i];
                    if (n.state === 'flagged') flaggedCount++;
                    else if (n.state === 'closed') closed.push(n);
                }

                var remaining = cell.value - flaggedCount;
                if (closed.length > 0 && remaining > 0) {
                    constraints.push({ cells: closed, cellSet: makeCellSet(closed), remaining: remaining });
                }
            }
        }

        if (constraints.length === 0) {
            // No constraints — pick corner/edge cell (safest statistically)
            var best = null, bestScore = -1;
            for (var i = 0; i < closedCells.length; i++) {
                var cc = closedCells[i];
                var onEdge = (cc.col === 0 || cc.col === cols - 1 || cc.row === 0 || cc.row === rows - 1) ? 1 : 0;
                var neighbors = getNeighbors(grid, cc.col, cc.row, cols, rows);
                var openedNeighbors = 0;
                for (var j = 0; j < neighbors.length; j++) {
                    if (neighbors[j].state === 'opened') openedNeighbors++;
                }
                var score = onEdge * 10 + openedNeighbors;
                if (score > bestScore) { bestScore = score; best = cc; }
            }
            return best || closedCells[0];
        }

        // Approximate probability
        var scored = closedCells.map(function(cell) {
            var totalWeight = 0;
            var weightedProb = 0;
            var maxProb = 0;
            var minProb = 1;
            var involvedConstraints = 0;

            for (var i = 0; i < constraints.length; i++) {
                var con = constraints[i];
                if (!setContains(con.cellSet, cell)) continue;

                involvedConstraints++;
                var prob = con.remaining / con.cells.length;
                var weight = 1 / con.cells.length;
                weightedProb += prob * weight;
                totalWeight += weight;
                if (prob > maxProb) maxProb = prob;
                if (prob < minProb) minProb = prob;
            }

            var avgProb = totalWeight > 0 ? weightedProb / totalWeight : 0.5;
            var risk = avgProb;

            if (involvedConstraints >= 3) risk *= 0.9;
            if (involvedConstraints >= 4) risk *= 0.9;
            if (minProb < 0.3) risk *= 0.8;

            return { cell: cell, risk: risk, prob: avgProb, maxProb: maxProb };
        });

        scored.sort(function(a, b) {
            if (Math.abs(a.risk - b.risk) > 0.02) return a.risk - b.risk;
            return a.maxProb - b.maxProb;
        });

        return scored[0].cell;
    }

    // --- Click ---

    function clickCell(element, rightClick) {
        var rect = element.getBoundingClientRect();
        var x = rect.left + rect.width / 2;
        var y = rect.top + rect.height / 2;
        var btn = rightClick ? 2 : 0;
        var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: btn };

        try { element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: btn, pointerId: 1, pointerType: 'mouse' })); } catch(e) {}
        element.dispatchEvent(new MouseEvent('mousedown', opts));
        try { element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: btn, pointerId: 1, pointerType: 'mouse' })); } catch(e) {}
        element.dispatchEvent(new MouseEvent('mouseup', opts));
        if (rightClick) element.dispatchEvent(new MouseEvent('contextmenu', opts));
        else element.dispatchEvent(new MouseEvent('click', opts));
    }

    // --- Overlays ---

    function clearOverlays() {
        document.querySelectorAll('.ms-overlay').forEach(function(el) { el.remove(); });
    }

    function drawOverlays(result, guessCell, mines) {
        clearOverlays();
        var size = getCellSize();

        result.safe.forEach(function(cell) {
            var rect = cell.el.getBoundingClientRect();
            var div = document.createElement('div');
            div.className = 'ms-overlay';
            div.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + size + 'px;height:' + size + 'px;border:2px solid #00ff9d;box-sizing:border-box;pointer-events:none;z-index:999998;display:flex;align-items:center;justify-content:center;font:bold 10px Consolas;color:#00ff9d;text-shadow:0 0 4px #00ff9d;';
            div.textContent = 'S';
            document.body.appendChild(div);
        });

        if (mines) {
            var keys = Object.keys(mines);
            for (var i = 0; i < keys.length; i++) {
                var mk = keys[i];
                var data = getCells();
                if (!data) continue;
                var cell = data.grid[mk];
                if (!cell || !cell.el) continue;
                var rect = cell.el.getBoundingClientRect();
                var div = document.createElement('div');
                div.className = 'ms-overlay';
                div.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + size + 'px;height:' + size + 'px;background:rgba(255,0,100,0.25);border:2px solid #ff0064;box-sizing:border-box;pointer-events:none;z-index:999998;display:flex;align-items:center;justify-content:center;font:bold 12px Consolas;color:#ff0064;text-shadow:0 0 6px #ff0064;';
                div.textContent = 'M';
                document.body.appendChild(div);
            }
        }

        if (guessCell) {
            var rect = guessCell.el.getBoundingClientRect();
            var div = document.createElement('div');
            div.className = 'ms-overlay';
            div.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + size + 'px;height:' + size + 'px;border:2px solid #ffc800;box-sizing:border-box;pointer-events:none;z-index:999998;display:flex;align-items:center;justify-content:center;font:bold 10px Consolas;color:#ffc800;text-shadow:0 0 4px #ffc800;';
            div.textContent = 'G';
            document.body.appendChild(div);
        }
    }

    // --- UI ---

    function setStatus(text, color) {
        var el = document.getElementById('ms-status');
        if (el) { el.textContent = text; el.style.color = color || '#00ff9d'; }
    }

    function createUI() {
        var panel = document.createElement('div');
        panel.id = 'ms-panel';
        panel.innerHTML = '<div style="position:fixed;top:10px;right:10px;z-index:999999;background:#0f0f0f;border:1px solid #00ff9d;padding:16px;color:#e0ffe0;font-family:Consolas,monospace;min-width:200px;font-size:12px;">' +
            '<div id="ms-status" style="padding:6px;border:1px solid #333;margin-bottom:10px;text-align:center;color:#00ff9d;font-size:11px;">Ready</div>' +
            '<div style="display:flex;gap:6px;">' +
            '<button id="ms-btn-analyze" style="flex:1;padding:8px;background:#0f0f0f;border:1px solid #00ff9d;color:#00ff9d;cursor:pointer;font-family:Consolas,monospace;font-size:11px;font-weight:bold;">Analyze</button>' +
            '<button id="ms-btn-auto" style="flex:1;padding:8px;background:#0f0f0f;border:1px solid #00ff9d;color:#00ff9d;cursor:pointer;font-family:Consolas,monospace;font-size:11px;font-weight:bold;">Auto</button>' +
            '</div>' +
            '<div style="margin-top:10px;font-size:9px;color:#555;text-align:center;">Powered by <a href="https://github.com/cannabis-intelligence" target="_blank" style="color:#00ff9d;text-decoration:none;">cannabis intelligence</a></div>' +
            '</div>';
        document.body.appendChild(panel);

        document.getElementById('ms-btn-analyze').addEventListener('click', toggleAnalyze);
        document.getElementById('ms-btn-auto').addEventListener('click', toggleAutoSolve);
    }

    // --- Actions ---

    function resetState() {
        processedCells = {};
        stepCount = 0;
        guessCount = 0;
    }

    function executeStep() {
        var gs = isGameOver();
        if (gs === 'lost') { setStatus('Fail', '#ff0064'); solving = false; return true; }
        if (gs === 'won') { if (!watching) setStatus('Done', '#00ff9d'); solving = false; return true; }

        var result = analyze();
        if (!result) { solving = false; return true; }

        // Click 1 safe cell, then stop
        if (result.safe.length > 0) {
            var cell = result.safe[0];
            clickCell(cell.el, false);
            processedCells[cell.col + ',' + cell.row] = true;
            stepCount++;

            if (watching) {
                var freshResult = analyze();
                if (freshResult) {
                    var mines = freshResult.knownMines || {};
                    drawOverlays(freshResult, null, mines);
                }
            }
            return false;
        }

        // Only guess if no safe cells
        if (result.closed.length > 0) {
            var data = getCells();
            var guess = pickBestGuess(result.closed, data.grid, data.cols, data.rows) || result.closed[Math.floor(Math.random() * result.closed.length)];
            clickCell(guess.el, false);
            processedCells[guess.col + ',' + guess.row] = true;
            stepCount++;
            guessCount++;
        } else {
            solving = false;
            return true;
        }

        return false;
    }

    function toggleAutoSolve() {
        if (solving) {
            solving = false;
            setButtonActive('ms-btn-auto', false);
            if (!watching) setStatus('Ready', '#00ff9d');
            return;
        }

        resetState();
        solving = true;
        setButtonActive('ms-btn-auto', true);
        if (!watching) setStatus('Auto on', '#00ff9d');

        function loop() {
            if (!solving) return;
            detectNewGame();
            var gs = isGameOver();
            if (gs) {
                if (!watching) setStatus(gs === 'lost' ? 'Fail' : 'Done', gs === 'lost' ? '#ff0064' : '#00ff9d');
                setTimeout(loop, ACTION_DELAY);
                return;
            }
            if (!watching && solving) setStatus('Auto on', '#00ff9d');

            // Always update overlays
            var overlayResult = analyze();
            if (overlayResult) {
                var mines = overlayResult.knownMines || {};
                drawOverlays(overlayResult, null, mines);
            }

            var done = executeStep();
            setTimeout(loop, done ? ACTION_DELAY : ACTION_DELAY);
        }

        loop();
    }

    function setButtonActive(id, active) {
        var btn = document.getElementById(id);
        if (!btn) return;
        if (active) {
            btn.style.background = '#00ff9d';
            btn.style.color = '#0f0f0f';
        } else {
            btn.style.background = '#0f0f0f';
            btn.style.color = '#00ff9d';
        }
    }

    function toggleAnalyze() {
        if (watching) {
            watching = false;
            clearOverlays();
            setButtonActive('ms-btn-analyze', false);
            setStatus('Analyze off', '#555');
            return;
        }

        watching = true;
        setButtonActive('ms-btn-analyze', true);
        setStatus('Analyzing...', '#00ff9d');

        function loop() {
            if (!watching) return;
            detectNewGame();
            var gs = isGameOver();
            if (gs) {
                setStatus(gs === 'lost' ? 'Fail' : 'Done', gs === 'lost' ? '#ff0064' : '#00ff9d');
                clearOverlays();
                setTimeout(loop, WATCH_INTERVAL);
                return;
            }

            var result = analyze();
            if (result) {
                var mines = result.knownMines || {};
                drawOverlays(result, null, mines);
                setStatus('Analyze: ' + result.safe.length + ' safe | ' + Object.keys(mines).length + ' mines', '#00ff9d');
            }

            setTimeout(loop, WATCH_INTERVAL);
        }

        loop();
    }

    // --- Init ---

    function waitForGame() {
        var check = setInterval(function() {
            if (document.querySelectorAll('.cell').length >= 16) {
                clearInterval(check);
                createUI();
                setStatus('Ready', '#00ff9d');
                setInterval(function() { detectNewGame(); }, 100);
            }
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForGame);
    } else {
        waitForGame();
    }
})();
