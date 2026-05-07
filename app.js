const config = window.VERITAS_DASHBOARD_CONFIG || {};
const pocketBaseUrl = (config.pocketBaseUrl || "").replace(/\/$/, "");
const refreshSeconds = Number(config.refreshSeconds || 60);
const ROSARY_DURATION_ADJUSTMENT = 0.8;
const MAX_CHART_ROWS = 12;

const dashboardState = {
  currentView: "overview",
  sessions: [],
  attendance: [],
  rosaryLeaders: [],
  scores: [],
  rosaryDailyStats: [],
  quizDailyStats: [],
  selectedRosaryDay: "",
  selectedRosarySessionId: "",
  selectedQuizDay: "",
};

const elements = {
  status: document.querySelector("#status"),
  lastUpdated: document.querySelector("#last-updated"),
  timezoneLabel: document.querySelector("#timezone-label"),
  rosarySessions: document.querySelector("#rosary-sessions"),
  rosaryLeaders: document.querySelector("#rosary-leaders"),
  dailyQuiz: document.querySelector("#daily-quiz"),
  weeklyQuiz: document.querySelector("#weekly-quiz"),
  totalQuiz: document.querySelector("#total-quiz"),
  userSearch: document.querySelector("#user-search"),
  userSearchDropdown: document.querySelector("#user-search-dropdown"),
  searchResult: document.querySelector("#search-result"),
  rosarySummary: document.querySelector("#rosary-summary"),
  rosaryComboChart: document.querySelector("#rosary-combo-chart"),
  rosaryLeaderChart: document.querySelector("#rosary-leader-chart"),
  rosaryDrilldownTitle: document.querySelector("#rosary-drilldown-title"),
  rosaryDrilldownSummary: document.querySelector("#rosary-drilldown-summary"),
  rosarySessionDrilldown: document.querySelector("#rosary-session-drilldown"),
  rosaryDrilldownTable: document.querySelector("#rosary-drilldown-table"),
  quizSummary: document.querySelector("#quiz-summary"),
  quizComboChart: document.querySelector("#quiz-combo-chart"),
  quizTotalChart: document.querySelector("#quiz-total-chart"),
  quizDrilldownTitle: document.querySelector("#quiz-drilldown-title"),
  quizDrilldownSummary: document.querySelector("#quiz-drilldown-summary"),
  quizDrilldownTable: document.querySelector("#quiz-drilldown-table"),
};

setTimezoneLabel();
setActiveView("overview");

async function loadDashboard() {
  if (!pocketBaseUrl || pocketBaseUrl.includes("your-pocketbase-url")) {
    setStatus("Configure web/config.js", true);
    renderEmptyState();
    return;
  }

  setStatus("Refreshing");

  try {
    const [sessions, attendance, scores] = await Promise.all([
      fetchCollection("rosary_sessions", { sort: "-started_at", perPage: 200 }),
      fetchCollection("rosary_attendance", { sort: "-time_in_channel_seconds", perPage: 1000 }),
      fetchCollection("bible_trivia_scores", { sort: "-total_points", perPage: 1000 }),
    ]);

    const normalizedScores = normalizeScores(scores);
    dashboardState.sessions = sessions;
    dashboardState.attendance = attendance;
    dashboardState.scores = normalizedScores;
    dashboardState.rosaryDailyStats = groupRosaryByLocalDay(sessions, attendance);
    dashboardState.quizDailyStats = groupQuizByDay(normalizedScores);

    if (!dashboardState.selectedRosaryDay) {
      dashboardState.selectedRosaryDay = dashboardState.rosaryDailyStats.at(-1)?.key || "";
    }
    if (!dashboardState.selectedQuizDay) {
      dashboardState.selectedQuizDay = dashboardState.quizDailyStats.at(-1)?.key || "";
    }

    renderOverview();
    renderRosaryAnalytics();
    renderQuizAnalytics();

    if (elements.lastUpdated) {
      elements.lastUpdated.textContent = `Updated ${formatLocalTime(new Date())}`;
    }
    setStatus("Live");
  } catch (error) {
    console.error(error);
    setStatus("Error", true);
  }
}

async function fetchCollection(collection, params) {
  const query = new URLSearchParams({
    page: "1",
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  });
  const response = await fetch(`${pocketBaseUrl}/api/collections/${collection}/records?${query}`);

  if (!response.ok) {
    throw new Error(`${collection} returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  return payload.items || [];
}

function renderOverview() {
  renderRosarySessions(dashboardState.sessions);
  dashboardState.rosaryLeaders = buildRosaryLeaders(dashboardState.sessions, dashboardState.attendance);
  renderRosaryLeaders();
  renderQuizLeaders(dashboardState.scores);
  renderSearchResult();
}

function renderRosarySessions(sessions) {
  if (!sessions.length) {
    elements.rosarySessions.innerHTML = '<tr><td colspan="3" class="empty">No Rosary sessions yet.</td></tr>';
    return;
  }

  elements.rosarySessions.innerHTML = sessions
    .slice(0, 14)
    .map(
      (session) => `
        <tr>
          <td>
            <strong>${escapeHtml(formatLocalDateTime(session.started_at))}</strong>
            <span class="sub block">${escapeHtml(getTimeZoneName())}</span>
          </td>
          <td>${escapeHtml(formatDuration(adjustedSeconds(session.duration_seconds || 0)))}</td>
          <td>${Number(session.attendee_count || 0)}</td>
        </tr>
      `,
    )
    .join("");
}

function buildRosaryLeaders(sessions, attendance) {
  const leadersByUser = new Map();
  const attendedSessionsByUser = new Map();

  for (const record of attendance) {
    const userId = String(record.user_id || "");
    if (!userId) continue;

    const sessionId = getRelationId(record.session_id);
    if (sessionId) {
      const attended = attendedSessionsByUser.get(userId) || new Set();
      attended.add(sessionId);
      attendedSessionsByUser.set(userId, attended);
    }

    const current = leadersByUser.get(userId) || {
      user_id: userId,
      display_name: record.display_name || record.username || userId,
      username: record.username || "",
      time_in_channel_seconds: 0,
      sessionIds: new Set(),
      sessions: 0,
      streak: 0,
    };

    current.time_in_channel_seconds += Number(record.time_in_channel_seconds || 0);
    if (sessionId) current.sessionIds.add(sessionId);
    current.sessions = current.sessionIds.size || current.sessions + 1;
    leadersByUser.set(userId, current);
  }

  for (const leader of leadersByUser.values()) {
    leader.streak = calculateCurrentStreak(sessions, attendedSessionsByUser.get(leader.user_id) || new Set());
    delete leader.sessionIds;
  }

  return [...leadersByUser.values()].sort((a, b) => {
    if (b.streak !== a.streak) return b.streak - a.streak;
    if (b.sessions !== a.sessions) return b.sessions - a.sessions;
    return b.time_in_channel_seconds - a.time_in_channel_seconds;
  });
}

function calculateCurrentStreak(sessionOrder, attendedSessions) {
  const todayKey = getLocalDateKey(new Date());
  let streak = 1; // assume they went today or will go today
  let lastCountedDay = todayKey;
  const seenDays = new Set([todayKey]);

  for (const session of sessionOrder) {
    const sessionDay = getLocalDateKey(session.started_at);
    if (!sessionDay || seenDays.has(sessionDay)) continue;
    seenDays.add(sessionDay);

    if (sessionDay === todayKey) continue;

    const expectedPrevious = previousLocalDateKey(lastCountedDay);
    if (sessionDay !== expectedPrevious) break;

    if (!attendedSessions.has(session.id)) break;

    streak += 1;
    lastCountedDay = sessionDay;
  }

  return streak;
}

function renderRosaryLeaders() {
  renderLeaderList(
    elements.rosaryLeaders,
    dashboardState.rosaryLeaders,
    (leader) => formatDuration(leader.time_in_channel_seconds),
    (leader) => `${leader.streak} streak | ${leader.sessions} sessions`,
  );
}

function renderQuizLeaders(scores) {
  const dailyAll = scores.filter((score) => score.daily_points > 0).sort((a, b) => b.daily_points - a.daily_points);
  const weeklyAll = scores.filter((score) => score.weekly_points > 0).sort((a, b) => b.weekly_points - a.weekly_points);
  const totalAll = scores.filter((score) => score.total_points > 0).sort((a, b) => b.total_points - a.total_points);

  renderLeaderList(elements.dailyQuiz, dailyAll.slice(0, 5), (score) => `${score.daily_points}`, () => "points today");
  renderLeaderList(elements.weeklyQuiz, weeklyAll.slice(0, 5), (score) => `${score.weekly_points}`, () => "points this week");
  renderLeaderList(elements.totalQuiz, totalAll.slice(0, 5), (score) => `${score.total_points}`, () => "points all time");
}

function renderRosaryAnalytics() {
  const dailyStats = dashboardState.rosaryDailyStats;
  const selected = dailyStats.find((day) => day.key === dashboardState.selectedRosaryDay) || dailyStats.at(-1);
  const totalRosaries = sumBy(dailyStats, "rosaries");
  const totalAttendance = sumBy(dailyStats, "attendance");
  const totalDuration = sumBy(dailyStats, "durationSeconds");
  const bestDay = [...dailyStats].sort((a, b) => b.attendance - a.attendance)[0];

  renderSummaryCards(elements.rosarySummary, [
    { label: "Total Rosaries", value: totalRosaries, sub: `${dailyStats.length} local days tracked` },
    { label: "Total Attendance", value: totalAttendance, sub: "Sum of session attendee counts" },
    { label: "Adjusted Prayer Time", value: formatDuration(totalDuration), sub: "After 20% adjustment" },
    { label: "Best Attendance Day", value: bestDay ? bestDay.label : "-", sub: bestDay ? `${bestDay.attendance} attendees` : "No data yet" },
  ]);

  renderDualAxisChart(elements.rosaryComboChart, dailyStats.slice(-30), {
    selectedKey: selected?.key || "",
    leftLabel: "Rosaries",
    rightLabel: "Attendance",
    leftValue: (day) => day.rosaries,
    rightValue: (day) => day.attendance,
    leftText: (value) => `${value} rosaries`,
    rightText: (value) => `${value} attendance`,
    onSelect: (key) => {
      dashboardState.selectedRosaryDay = key;
      dashboardState.selectedRosarySessionId = "";
      renderRosaryAnalytics();
    },
  });

  renderBarChart(
    elements.rosaryLeaderChart,
    dashboardState.rosaryLeaders.slice(0, MAX_CHART_ROWS).map((leader) => ({
      label: leader.display_name || leader.user_id,
      value: Math.round(leader.time_in_channel_seconds / 60),
      valueLabel: `${formatDuration(leader.time_in_channel_seconds)} | ${leader.streak} streak`,
    })),
    "No Rosary attendance yet.",
  );

  renderRosaryDrilldown(selected);
}

function renderRosaryDrilldown(day) {
  if (!day) {
    elements.rosaryDrilldownTitle.textContent = "No Rosary Day Selected";
    elements.rosaryDrilldownSummary.innerHTML = "";
    if (elements.rosarySessionDrilldown) elements.rosarySessionDrilldown.innerHTML = "";
    elements.rosaryDrilldownTable.innerHTML = '<tr><td colspan="3" class="empty">No Rosary data yet.</td></tr>';
    return;
  }

  const sessionsForDay = [...day.sessions].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  if (!dashboardState.selectedRosarySessionId && sessionsForDay.length) {
    dashboardState.selectedRosarySessionId = String(sessionsForDay[0].id);
  }

  const selectedSession = sessionsForDay.find((session) => String(session.id) === dashboardState.selectedRosarySessionId) || sessionsForDay[0];
  const selectedSessionId = selectedSession ? String(selectedSession.id) : "";
  dashboardState.selectedRosarySessionId = selectedSessionId;

  const filteredRows = selectedSessionId
    ? day.attendanceRows.filter((row) => getRelationId(row.session_id) === selectedSessionId)
    : day.attendanceRows;
  const selectedAttendance = selectedSession
    ? Number(selectedSession.attendee_count || filteredRows.length || 0)
    : day.attendance;
  const selectedDurationSeconds = selectedSession
    ? adjustedSeconds(selectedSession.duration_seconds || 0)
    : day.durationSeconds;
  const rawAttendanceSeconds = sumBy(filteredRows, "time_in_channel_seconds");

  elements.rosaryDrilldownTitle.textContent = `${day.label}${selectedSession ? ` • ${formatLocalTime(selectedSession.started_at)}` : ""}`;
  renderDrilldownStats(elements.rosaryDrilldownSummary, [
    { label: "Day Rosaries", value: day.rosaries },
    { label: "Session Attendance", value: selectedAttendance },
    { label: "Session Duration", value: formatDuration(selectedDurationSeconds) },
    { label: "Raw Attendance Time", value: formatDuration(rawAttendanceSeconds) },
  ]);

  renderSessionDrilldownButtons(day, sessionsForDay, selectedSessionId);

  const rows = filteredRows.length
    ? filteredRows
        .sort((a, b) => Number(b.time_in_channel_seconds || 0) - Number(a.time_in_channel_seconds || 0))
        .map(
          (row) => `
            <tr>
              <td>${escapeHtml(row.display_name || row.username || row.user_id || "Unknown")}</td>
              <td>${escapeHtml(formatDuration(row.time_in_channel_seconds || 0))}</td>
              <td>${escapeHtml(row.sessionLabel || "-")}</td>
            </tr>
          `,
        )
        .join("")
    : '<tr><td colspan="3" class="empty">No attendance records found for this session.</td></tr>';

  elements.rosaryDrilldownTable.innerHTML = rows;
}

function renderSessionDrilldownButtons(day, sessions, selectedSessionId) {
  if (!elements.rosarySessionDrilldown) return;

  if (!sessions.length) {
    elements.rosarySessionDrilldown.innerHTML = '<p class="empty">No sessions found for this day.</p>';
    return;
  }

  elements.rosarySessionDrilldown.innerHTML = `
    <p class="session-drilldown-title">Session drilldown</p>
    <div class="session-pills">
      ${sessions
        .map((session) => {
          const id = String(session.id);
          const active = id === selectedSessionId ? " active" : "";
          return `
            <button class="session-pill${active}" type="button" data-session-id="${escapeAttribute(id)}">
              <strong>${escapeHtml(formatLocalTime(session.started_at))}</strong>
              <span>${escapeHtml(formatDuration(adjustedSeconds(session.duration_seconds || 0)))} • ${Number(session.attendee_count || 0)} attendees</span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;

  elements.rosarySessionDrilldown.querySelectorAll("[data-session-id]").forEach((button) => {
    button.addEventListener("click", () => {
      dashboardState.selectedRosarySessionId = button.dataset.sessionId;
      renderRosaryDrilldown(day);
    });
  });
}

function renderQuizAnalytics() {
  const dailyStats = dashboardState.quizDailyStats;
  const selected = dailyStats.find((day) => day.key === dashboardState.selectedQuizDay) || dailyStats.at(-1);
  const topTotal = [...dashboardState.scores].sort((a, b) => b.total_points - a.total_points)[0];
  const activeToday = dashboardState.scores.filter((score) => score.daily_points > 0).length;
  const totalDistributed = sumBy(dailyStats, "points");
  const bestDay = [...dailyStats].sort((a, b) => b.points - a.points)[0];

  renderSummaryCards(elements.quizSummary, [
    { label: "People Today", value: activeToday, sub: "Users with daily points" },
    { label: "Points Distributed", value: totalDistributed, sub: `${dailyStats.length} day groups tracked` },
    { label: "Best Points Day", value: bestDay ? bestDay.label : "-", sub: bestDay ? `${bestDay.points} points` : "No data yet" },
    { label: "Top All-Time Player", value: topTotal?.display_name || "-", sub: topTotal ? `${topTotal.total_points} points` : "No scores yet" },
  ]);

  renderDualAxisChart(elements.quizComboChart, dailyStats.slice(-30), {
    selectedKey: selected?.key || "",
    leftLabel: "People",
    rightLabel: "Points",
    leftValue: (day) => day.players,
    rightValue: (day) => day.points,
    leftText: (value) => `${value} people`,
    rightText: (value) => `${value} pts`,
    onSelect: (key) => {
      dashboardState.selectedQuizDay = key;
      renderQuizAnalytics();
    },
  });

  renderBarChart(
    elements.quizTotalChart,
    [...dashboardState.scores]
      .filter((score) => score.total_points > 0)
      .sort((a, b) => b.total_points - a.total_points)
      .slice(0, MAX_CHART_ROWS)
      .map((score) => ({ label: score.display_name, value: score.total_points, valueLabel: `${score.total_points} pts` })),
    "No Bible quiz scores yet.",
  );

  renderQuizDrilldown(selected);
}

function renderQuizDrilldown(day) {
  if (!day) {
    elements.quizDrilldownTitle.textContent = "No Quiz Day Selected";
    elements.quizDrilldownSummary.innerHTML = "";
    elements.quizDrilldownTable.innerHTML = '<tr><td colspan="3" class="empty">No quiz data yet.</td></tr>';
    return;
  }

  elements.quizDrilldownTitle.textContent = day.label;
  renderDrilldownStats(elements.quizDrilldownSummary, [
    { label: "People", value: day.players },
    { label: "Points", value: day.points },
    { label: "Avg Points", value: day.players ? Math.round(day.points / day.players) : 0 },
  ]);

  const rows = day.rows.length
    ? day.rows
        .sort((a, b) => b.daily_points - a.daily_points)
        .map(
          (row) => `
            <tr>
              <td>${escapeHtml(row.display_name || row.username || row.user_id || "Unknown")}</td>
              <td>${Number(row.daily_points || 0)}</td>
              <td>${Number(row.total_points || 0)}</td>
            </tr>
          `,
        )
        .join("")
    : '<tr><td colspan="3" class="empty">No users found for this day.</td></tr>';

  elements.quizDrilldownTable.innerHTML = rows;
}

function groupRosaryByLocalDay(sessions, attendance) {
  const sessionById = new Map(sessions.map((session) => [String(session.id), session]));
  const byDay = new Map();

  for (const session of sessions) {
    const date = parseDate(session.started_at);
    if (!date) continue;
    const key = getLocalDateKey(date);
    const current = byDay.get(key) || makeRosaryDay(key, date);
    current.rosaries += 1;
    current.attendance += Number(session.attendee_count || 0);
    current.durationSeconds += adjustedSeconds(session.duration_seconds || 0);
    current.sessions.push(session);
    byDay.set(key, current);
  }

  for (const record of attendance) {
    const session = sessionById.get(getRelationId(record.session_id));
    const date = parseDate(session?.started_at || record.created || record.updated);
    if (!date) continue;
    const key = getLocalDateKey(date);
    const current = byDay.get(key) || makeRosaryDay(key, date);
    current.attendanceRows.push({
      ...record,
      session_id: getRelationId(record.session_id),
      sessionLabel: session?.started_at ? formatLocalDateTime(session.started_at) : "Unknown session",
    });
    byDay.set(key, current);
  }

  return [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function makeRosaryDay(key, date) {
  return {
    key,
    label: formatLocalShortDate(date),
    rosaries: 0,
    attendance: 0,
    durationSeconds: 0,
    sessions: [],
    attendanceRows: [],
  };
}

function groupQuizByDay(scores) {
  const byDay = new Map();

  for (const score of scores) {
    const key = score.day_key || getLocalDateKey(score.updated || score.created || new Date());
    if (!key) continue;
    const date = localDateFromKey(key);
    const current = byDay.get(key) || { key, label: formatLocalShortDate(date), players: 0, points: 0, rows: [] };

    const points = Number(score.raw_daily_points || score.daily_points || 0);
    if (points > 0) {
      current.players += 1;
      current.points += points;
      current.rows.push({ ...score, daily_points: points });
    }

    byDay.set(key, current);
  }

  return [...byDay.values()].filter((day) => day.players > 0 || day.points > 0).sort((a, b) => a.key.localeCompare(b.key));
}

function normalizeScores(scores) {
  const today = getLocalDateKey(new Date());
  const weekStart = getLocalWeekStartKey(new Date());

  return scores.map((score) => {
    const dayKey = normalizeDateKey(score.day_start_date || score.created || score.updated);
    const weekKey = normalizeDateKey(score.week_start_date);
    const rawDailyPoints = Number(score.daily_points || 0);
    const rawWeeklyPoints = Number(score.weekly_points || 0);

    return {
      user_id: String(score.user_id || ""),
      display_name: score.display_name || score.username || "Unknown",
      username: score.username || "",
      total_points: Number(score.total_points || 0),
      daily_points: dayKey === today ? rawDailyPoints : 0,
      weekly_points: weekKey === weekStart ? rawWeeklyPoints : 0,
      raw_daily_points: rawDailyPoints,
      raw_weekly_points: rawWeeklyPoints,
      day_key: dayKey,
      week_key: weekKey,
      created: score.created,
      updated: score.updated,
    };
  });
}

function renderDualAxisChart(container, rows, options) {
  if (!container) return;
  const cleanRows = rows.filter((row) => Number(options.leftValue(row) || 0) > 0 || Number(options.rightValue(row) || 0) > 0);

  if (!cleanRows.length) {
    container.innerHTML = '<div class="empty chart-empty">No chart data yet.</div>';
    return;
  }

  const width = Math.max(900, cleanRows.length * 80);
  const height = 340;
  const pad = { top: 34, right: 72, bottom: 72, left: 62 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const maxLeft = Math.max(...cleanRows.map((row) => Number(options.leftValue(row) || 0)), 1);
  const maxRight = Math.max(...cleanRows.map((row) => Number(options.rightValue(row) || 0)), 1);
  const step = chartWidth / cleanRows.length;
  const barWidth = Math.min(42, step * 0.52);

  const yLeft = (value) => pad.top + chartHeight - (Number(value || 0) / maxLeft) * chartHeight;
  const yRight = (value) => pad.top + chartHeight - (Number(value || 0) / maxRight) * chartHeight;
  const xCenter = (index) => pad.left + step * index + step / 2;
  const linePoints = cleanRows.map((row, index) => `${xCenter(index)},${yRight(options.rightValue(row))}`).join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const y = pad.top + chartHeight - chartHeight * ratio;
      return `
        <line class="chart-grid" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"></line>
        <text class="chart-text" x="${pad.left - 10}" y="${y + 4}" text-anchor="end">${Math.round(maxLeft * ratio)}</text>
        <text class="chart-text" x="${width - pad.right + 10}" y="${y + 4}" text-anchor="start">${Math.round(maxRight * ratio)}</text>
      `;
    })
    .join("");

  const bars = cleanRows
    .map((row, index) => {
      const value = Number(options.leftValue(row) || 0);
      const x = xCenter(index) - barWidth / 2;
      const y = yLeft(value);
      const h = pad.top + chartHeight - y;
      const active = row.key === options.selectedKey ? " active" : "";
      return `
        <rect class="chart-bar${active}" x="${x}" y="${y}" width="${barWidth}" height="${Math.max(h, 2)}" rx="6" data-key="${escapeAttribute(row.key)}">
          <title>${escapeHtml(row.label)}: ${escapeHtml(options.leftText(value))}, ${escapeHtml(options.rightText(options.rightValue(row)))}</title>
        </rect>
      `;
    })
    .join("");

  const labels = cleanRows
    .map((row, index) => {
      const transform = `translate(${xCenter(index)},${height - 36}) rotate(-35)`;
      return `<text class="chart-text" transform="${transform}" text-anchor="end">${escapeHtml(row.label)}</text>`;
    })
    .join("");

  const points = cleanRows
    .map((row, index) => {
      const active = row.key === options.selectedKey ? " active" : "";
      return `
        <circle class="chart-point${active}" cx="${xCenter(index)}" cy="${yRight(options.rightValue(row))}" r="4.5" data-key="${escapeAttribute(row.key)}">
          <title>${escapeHtml(row.label)}: ${escapeHtml(options.rightText(options.rightValue(row)))}</title>
        </circle>
      `;
    })
    .join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(options.leftLabel)} and ${escapeAttribute(options.rightLabel)} by day">
      <text class="chart-title-left" x="${pad.left}" y="20">${escapeHtml(options.leftLabel)}</text>
      <text class="chart-title-right" x="${width - pad.right}" y="20" text-anchor="end">${escapeHtml(options.rightLabel)}</text>
      ${gridLines}
      <line class="chart-axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + chartHeight}"></line>
      <line class="chart-axis" x1="${width - pad.right}" y1="${pad.top}" x2="${width - pad.right}" y2="${pad.top + chartHeight}"></line>
      <line class="chart-axis" x1="${pad.left}" y1="${pad.top + chartHeight}" x2="${width - pad.right}" y2="${pad.top + chartHeight}"></line>
      ${bars}
      <polyline class="chart-line" points="${linePoints}"></polyline>
      ${points}
      ${labels}
    </svg>
  `;

  container.querySelectorAll("[data-key]").forEach((node) => {
    node.addEventListener("click", () => options.onSelect(node.dataset.key));
  });
}

function renderBarChart(container, rows, emptyText) {
  if (!container) return;
  const cleanRows = rows.filter((row) => Number(row.value || 0) > 0);

  if (!cleanRows.length) {
    container.innerHTML = `<div class="empty chart-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }

  const maxValue = Math.max(...cleanRows.map((row) => Number(row.value || 0)), 1);
  container.innerHTML = cleanRows
    .map((row) => {
      const percent = Math.max((Number(row.value || 0) / maxValue) * 100, 3);
      return `
        <div class="bar-row">
          <div class="bar-meta">
            <span class="bar-label">${escapeHtml(row.label)}</span>
            <span class="bar-value">${escapeHtml(row.valueLabel || row.value)}</span>
          </div>
          <div class="bar-track" aria-hidden="true"><span class="bar-fill" style="width: ${percent}%"></span></div>
        </div>
      `;
    })
    .join("");
}

function renderSummaryCards(container, cards) {
  if (!container) return;
  container.innerHTML = cards
    .map(
      (card) => `
        <div class="summary-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
          <small>${escapeHtml(card.sub)}</small>
        </div>
      `,
    )
    .join("");
}

function renderDrilldownStats(container, stats) {
  if (!container) return;
  container.innerHTML = stats
    .map(
      (stat) => `
        <div class="drilldown-stat">
          <span>${escapeHtml(stat.label)}</span>
          <strong>${escapeHtml(stat.value)}</strong>
        </div>
      `,
    )
    .join("");
}

function renderLeaderList(container, entries, pointsText, subText) {
  if (!container) return;

  if (!entries.length) {
    container.innerHTML = '<li class="empty">No scores yet.</li>';
    return;
  }

  container.innerHTML = entries
    .map(
      (entry, index) => `
        <li>
          <span class="rank">${index + 1}</span>
          <span>
            <span class="name">${escapeHtml(entry.display_name || "Unknown")}</span>
            <span class="sub block">${escapeHtml(subText(entry))}</span>
          </span>
          <span class="points">${escapeHtml(pointsText(entry))}</span>
        </li>
      `,
    )
    .join("");
}


function getSearchableUsers() {
  const users = new Map();

  for (const leader of dashboardState.rosaryLeaders) {
    const key = leader.user_id || leader.display_name;
    if (!key) continue;
    users.set(String(key), {
      user_id: leader.user_id || "",
      display_name: leader.display_name || leader.username || leader.user_id || "Unknown",
      username: leader.username || "",
      rosary: leader,
      quiz: null,
    });
  }

  for (const score of dashboardState.scores) {
    const key = score.user_id || score.display_name;
    if (!key) continue;
    const existing = users.get(String(key)) || {
      user_id: score.user_id || "",
      display_name: score.display_name || score.username || score.user_id || "Unknown",
      username: score.username || "",
      rosary: null,
      quiz: null,
    };
    existing.display_name = existing.display_name || score.display_name || "Unknown";
    existing.username = existing.username || score.username || "";
    existing.quiz = score;
    users.set(String(key), existing);
  }

  return [...users.values()].sort((a, b) =>
    String(a.display_name).localeCompare(String(b.display_name), undefined, { sensitivity: "base" }),
  );
}

function findUsers(query) {
  const cleanQuery = String(query || "").trim().toLowerCase();
  if (!cleanQuery) return [];

  return getSearchableUsers()
    .filter((user) =>
      [user.display_name, user.username, user.user_id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(cleanQuery)),
    )
    .slice(0, 10);
}

function renderSearchDropdown() {
  if (!elements.userSearch || !elements.userSearchDropdown) return;

  const query = elements.userSearch.value;
  const matches = findUsers(query);

  if (!query.trim() || !matches.length) {
    elements.userSearchDropdown.hidden = true;
    elements.userSearchDropdown.innerHTML = "";
    return;
  }

  elements.userSearchDropdown.innerHTML = matches
    .map(
      (user) => `
        <button class="search-option" type="button" role="option" data-user-id="${escapeAttribute(user.user_id || user.display_name)}">
          <strong>${escapeHtml(user.display_name || "Unknown")}</strong>
          <span class="sub">${escapeHtml(buildSearchOptionSubtext(user))}</span>
        </button>
      `,
    )
    .join("");
  elements.userSearchDropdown.hidden = false;

  elements.userSearchDropdown.querySelectorAll("[data-user-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const selected = getSearchableUsers().find(
        (user) => String(user.user_id || user.display_name) === button.dataset.userId,
      );
      if (!selected) return;
      elements.userSearch.value = selected.display_name || selected.user_id || "";
      elements.userSearchDropdown.hidden = true;
      renderSelectedUserStats(selected);
    });
  });
}

function buildSearchOptionSubtext(user) {
  const rosary = user.rosary
    ? `${user.rosary.streak} streak, ${user.rosary.sessions} Rosary sessions`
    : "No Rosary attendance";
  const quiz = user.quiz ? `${user.quiz.total_points} quiz points` : "No quiz score";
  return `${rosary} | ${quiz}`;
}

function renderSearchResult() {
  if (!elements.searchResult) return;

  const query = elements.userSearch?.value || "";
  if (!query.trim()) {
    elements.searchResult.textContent = "Type a name, then click a user to view their Rosary and Bible Quiz stats.";
    if (elements.userSearchDropdown) elements.userSearchDropdown.hidden = true;
    return;
  }

  const matches = findUsers(query);
  if (!matches.length) {
    elements.searchResult.textContent = "No matching user found.";
    return;
  }

  renderSelectedUserStats(matches[0]);
}

function renderSelectedUserStats(user) {
  if (!elements.searchResult) return;

  const rosaryText = user.rosary
    ? `Rosary: ${formatDuration(user.rosary.time_in_channel_seconds)}, ${user.rosary.sessions} sessions, ${user.rosary.streak} streak`
    : "Rosary: no attendance found";
  const quizText = user.quiz
    ? `Bible Quiz: ${user.quiz.daily_points} daily, ${user.quiz.weekly_points} weekly, ${user.quiz.total_points} all time`
    : "Bible Quiz: no score found";

  elements.searchResult.innerHTML = `<strong>${escapeHtml(user.display_name || "Unknown")}</strong> | ${escapeHtml(rosaryText)} | ${escapeHtml(quizText)}`;
}

function renderEmptyState() {
  elements.rosarySessions.innerHTML = '<tr><td colspan="3" class="error">Set your PocketBase URL in config.js.</td></tr>';
  elements.rosaryLeaders.innerHTML = '<li class="error">Waiting for config.</li>';
  elements.dailyQuiz.innerHTML = '<li class="error">Waiting for config.</li>';
  elements.weeklyQuiz.innerHTML = '<li class="error">Waiting for config.</li>';
  elements.totalQuiz.innerHTML = '<li class="error">Waiting for config.</li>';
}

function getRelationId(value) {
  if (Array.isArray(value)) return value[0] ? String(value[0]) : "";
  return value ? String(value) : "";
}

function adjustedSeconds(seconds) {
  return Math.floor(Number(seconds || 0) * ROSARY_DURATION_ADJUSTMENT);
}

function setStatus(text, isError = false) {
  if (!elements.status) return;
  elements.status.textContent = text;
  elements.status.classList.toggle("error", isError);
}

function sumBy(items, key) {
  return items.reduce((total, item) => total + Number(item[key] || 0), 0);
}

function formatDuration(seconds) {
  const totalMinutes = Math.floor(Number(seconds || 0) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getLocalDateKey(value) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateFromKey(key) {
  const [year, month, day] = String(key).split("-").map(Number);
  return new Date(year || 1970, (month || 1) - 1, day || 1);
}

function previousLocalDateKey(key) {
  const date = localDateFromKey(key);
  date.setDate(date.getDate() - 1);
  return getLocalDateKey(date);
}

function getLocalWeekStartKey(value) {
  const date = value instanceof Date ? new Date(value) : parseDate(value);
  if (!date) return "";
  date.setHours(0, 0, 0, 0);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return getLocalDateKey(date);
}

function normalizeDateKey(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  return getLocalDateKey(value);
}

function formatLocalDateTime(value) {
  const date = parseDate(value);
  if (!date) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatLocalShortDate(value) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "-";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatLocalTime(value) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "-";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function getTimeZoneName() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
}

function setTimezoneLabel() {
  if (!elements.timezoneLabel) return;
  elements.timezoneLabel.textContent = `Started times use your local timezone: ${getTimeZoneName()}.`;
}

function setActiveView(view) {
  dashboardState.currentView = view;
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  document.querySelectorAll("[data-view-section]").forEach((section) => {
    section.hidden = section.dataset.viewSection !== view;
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setActiveView(button.dataset.view));
});

if (elements.userSearch) {
  elements.userSearch.addEventListener("input", () => {
    renderSearchDropdown();
    renderSearchResult();
  });
  elements.userSearch.addEventListener("focus", renderSearchDropdown);
}

document.addEventListener("click", (event) => {
  if (!elements.userSearchDropdown || !elements.userSearch) return;
  const clickedInsideSearch = event.target.closest?.(".search-panel");
  if (!clickedInsideSearch) elements.userSearchDropdown.hidden = true;
});

loadDashboard();
window.setInterval(loadDashboard, refreshSeconds * 1000);
