const { 
  getAllGroups,
  addParticipantToGroup,
  promoteParticipant,
  demoteParticipant,
  getGroupAdmins,
  isParticipantInGroup,
  extractCleanPhoneNumber
} = require('../whatsappClient');
const { showAdminManagementMenu } = require('./menuHandler');
const { 
  safeDeleteMessage, 
  safeEditMessage, 
  createPagination,
  parsePhoneNumbers,
  generateProgressMessage,
  isRateLimitError,
  sleep,
  clearUserFlowState
} = require('../utils/helpers');

// Helper function to extract clean phone number from JID (simplified)
function extractCleanPhoneNumberForAdmin(jid, userStates = null, userId = null) {
  if (!jid) return 'Unknown';
  
  let identifier = jid.split('@')[0].split(':')[0];
  
  if (jid.includes('@s.whatsapp.net')) {
    if (identifier.startsWith('0') && identifier.length > 10) {
      return '62' + identifier.substring(1);
    }
    return identifier;
  }
  
  if (jid.includes('@lid')) {
    return identifier.substring(0, 12);
  }
  
  return identifier;
}

// NEW: Extract base name from group name
function extractGroupBaseName(groupName) {
  // Kalo ada bracket di awal, ambil sampai bracket tutup
  if (groupName.startsWith('[')) {
    const match = groupName.match(/^\[.*?\]/);
    if (match) return match[0]; // Return [AGODA]
  }
  
  // Kalo ga ada bracket, ambil kata pertama
  return groupName.split(' ')[0]; // Return AJ
}

// Handle admin-related callbacks
async function handleAdminCallbacks(query, bot, userStates) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  
  try {
    switch(true) {
      case data === 'admin_management':
        await showAdminManagementMenu(chatId, bot, query.message.message_id);
        break;
        
      case data === 'add_promote_admin':
        await handleAddPromoteAdmin(chatId, userId, bot, userStates);
        break;
        
      // NEW DEMOTE ALL FLOW
      case data === 'demote_admin':
        await handleDemoteAllAdmins(chatId, userId, bot, userStates);
        break;
        
      case data === 'search_demote_groups':
        await handleSearchDemoteGroups(chatId, userId, bot, userStates);
        break;
        
      case data === 'confirm_demote_all_flow':
        await handleConfirmDemoteAllFlow(chatId, userId, bot, userStates);
        break;
        
      case data === 'confirm_demote_all_execute':
        await handleExecuteDemoteAllFlow(chatId, userId, bot, userStates);
        break;
        
      case data.startsWith('select_demote_base_'):
        const baseName = data.replace('select_demote_base_', '');
        await handleDemoteBaseNameSelection(chatId, userId, baseName, bot, userStates);
        break;
        
      case data.startsWith('toggle_demote_all_group_'):
        const groupId = data.replace('toggle_demote_all_group_', '');
        await handleToggleDemoteAllGroupSelection(chatId, userId, groupId, bot, userStates, query.message.message_id);
        break;
        
      case data.startsWith('demote_all_groups_page_'):
        const page = parseInt(data.replace('demote_all_groups_page_', ''));
        await handleDemoteAllGroupsPage(chatId, userId, page, bot, userStates, query.message.message_id);
        break;
        
      // OLD ADD/PROMOTE FLOW
      case data === 'search_groups':
        await handleSearchGroups(chatId, userId, bot, userStates);
        break;
        
      case data === 'finish_group_selection':
        await handleFinishGroupSelection(chatId, userId, bot, userStates);
        break;
        
      case data === 'confirm_add_promote':
        await handleConfirmAddPromote(chatId, userId, bot, userStates);
        break;
        
      case data === 'cancel_admin_flow':
        await handleCancelAdminFlow(chatId, userId, bot, userStates);
        break;
        
      case data.startsWith('toggle_group_'):
        const addGroupId = data.replace('toggle_group_', '');
        await handleToggleGroupSelection(chatId, userId, addGroupId, bot, userStates, query.message.message_id);
        break;
        
      case data.startsWith('groups_page_'):
        const addPage = parseInt(data.replace('groups_page_', ''));
        await handleGroupsPage(chatId, userId, addPage, bot, userStates, query.message.message_id);
        break;
    }
  } catch (err) {
    console.error('Error in admin callback handler:', err);
    await bot.sendMessage(chatId, '❌ Terjadi error saat memproses admin management.');
  }
}

// Handle admin-related messages
async function handleAdminMessages(msg, bot, userStates) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  
  if (userStates[userId]?.adminFlow) {
    const state = userStates[userId].adminFlow;
    
    if (state.step === 'waiting_search_query' && state.type === 'add_promote') {
      await safeDeleteMessage(bot, chatId, msg.message_id);
      
      state.searchQuery = text.trim();
      state.currentPage = 0;
      state.step = 'select_groups';
      
      const loadingMsg = await bot.sendMessage(chatId, '⏳ Mencari grup...');
      await showGroupsList(chatId, userId, bot, userStates, loadingMsg.message_id);
      return true;
    }
    
    // NEW DEMOTE ALL FLOW - Handle search query
    if (state.step === 'waiting_demote_search_query' && state.type === 'demote_all') {
      await safeDeleteMessage(bot, chatId, msg.message_id);
      
      state.searchQuery = text.trim();
      state.currentPage = 0;
      state.step = 'select_base_names';
      
      const loadingMsg = await bot.sendMessage(chatId, '⏳ Mencari grup...');
      await showDemoteBaseNamesList(chatId, userId, bot, userStates, loadingMsg.message_id);
      return true;
    }
    
    if (state.step === 'waiting_admin_numbers') {
      await safeDeleteMessage(bot, chatId, msg.message_id);
      
      const { phoneNumbers, errors } = parsePhoneNumbers(text);
      
      if (errors.length > 0) {
        await bot.sendMessage(chatId, `❌ ${errors.join('\n')}\n\nFormat harus 10-15 digit angka saja, tanpa + atau spasi.`);
        return true;
      }
      
      if (phoneNumbers.length === 0) {
        await bot.sendMessage(chatId, '❌ Tidak ada nomor admin yang valid!');
        return true;
      }
      
      if (state.type === 'add_promote') {
        await handleAdminNumbersForAddPromote(chatId, userId, phoneNumbers, bot, userStates);
      }
      return true;
    }
  }
  
  return false;
}

// NEW DEMOTE ALL FLOW - Handle Demote All Admins
async function handleDemoteAllAdmins(chatId, userId, bot, userStates) {
  if (!userStates[userId]?.whatsapp?.isConnected) {
    await bot.sendMessage(chatId, '❌ WhatsApp belum terhubung! Login dulu ya.');
    return;
  }
  
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Mengambil daftar grup...');
  
  try {
    const groups = await getAllGroups(userId);
    
    if (!groups || groups.length === 0) {
      await safeEditMessage(bot, chatId, loadingMsg.message_id, '❌ Tidak ada grup yang ditemukan!', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }
    
    // Group by base name
    const groupedByBase = {};
    
    groups.forEach(group => {
      const baseName = extractGroupBaseName(group.name);
      
      if (!groupedByBase[baseName]) {
        groupedByBase[baseName] = [];
      }
      
      groupedByBase[baseName].push(group);
    });
    
    const baseNamesWithGroups = Object.keys(groupedByBase);
    
    if (baseNamesWithGroups.length === 0) {
      await safeEditMessage(bot, chatId, loadingMsg.message_id, '❌ Tidak ada grup yang ditemukan!', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }
    
    // Initialize demote all flow state
    userStates[userId].adminFlow = {
      type: 'demote_all',
      step: 'select_base_names',
      groupedData: groupedByBase,
      originalGroupedData: JSON.parse(JSON.stringify(groupedByBase)),
      selectedGroups: [],
      currentPage: 0,
      searchQuery: ''
    };
    
    await showDemoteBaseNamesList(chatId, userId, bot, userStates, loadingMsg.message_id);
    
  } catch (err) {
    console.error('Error getting groups for demote all:', err);
    await safeEditMessage(bot, chatId, loadingMsg.message_id, `❌ Error mengambil daftar grup: ${err.message}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
        ]
      }
    });
  }
}

// Show base names list
async function showDemoteBaseNamesList(chatId, userId, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  const baseNamesPerPage = 8;
  
  let filteredGroupedData = state.groupedData;
  if (state.searchQuery) {
    filteredGroupedData = {};
    for (const baseName in state.originalGroupedData) {
      if (baseName.toLowerCase().includes(state.searchQuery.toLowerCase())) {
        filteredGroupedData[baseName] = state.originalGroupedData[baseName];
      }
    }
  }
  
  const baseNames = Object.keys(filteredGroupedData);
  const pagination = createPagination(state.currentPage, baseNames.length, baseNamesPerPage);
  const pageBaseNames = baseNames.slice(pagination.startIndex, pagination.endIndex);
  
  let message = `👥 *Demote Semua Admin*\n\n`;
  
  if (state.searchQuery) {
    message += `🔍 Pencarian: "${state.searchQuery}"\n`;
    message += `📊 Hasil: ${baseNames.length} kelompok grup\n\n`;
  }
  
  message += `📄 Halaman ${pagination.currentPage + 1} dari ${pagination.totalPages}\n`;
  message += `📋 Pilih kelompok grup untuk demote semua adminnya:\n\n`;
  
  const keyboard = [];
  
  pageBaseNames.forEach(baseName => {
    const groupCount = filteredGroupedData[baseName].length;
    keyboard.push([{
      text: `${baseName} (${groupCount} grup)`,
      callback_data: `select_demote_base_${baseName}`
    }]);
  });
  
  const navButtons = [];
  if (pagination.hasPrev) {
    navButtons.push({ text: '◀️ Prev', callback_data: `demote_all_groups_page_${pagination.currentPage - 1}` });
  }
  if (pagination.hasNext) {
    navButtons.push({ text: 'Next ▶️', callback_data: `demote_all_groups_page_${pagination.currentPage + 1}` });
  }
  if (navButtons.length > 0) {
    keyboard.push(navButtons);
  }
  
  keyboard.push([{ text: '🔍 Cari Grup', callback_data: 'search_demote_groups' }]);
  keyboard.push([{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]);
  
  await safeEditMessage(bot, chatId, messageId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Handle search demote groups
async function handleSearchDemoteGroups(chatId, userId, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_all') return;
  
  state.step = 'waiting_demote_search_query';
  
  await bot.sendMessage(chatId, '🔍 *Cari Kelompok Grup*\n\nKetik nama kelompok grup yang mau dicari:', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Reset Filter', callback_data: 'demote_admin' }],
        [{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]
      ]
    }
  });
}

// Handle base name selection
async function handleDemoteBaseNameSelection(chatId, userId, baseName, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_all') return;
  
  const groups = state.groupedData[baseName];
  
  if (!groups || groups.length === 0) {
    await bot.sendMessage(chatId, '❌ Kelompok grup tidak ditemukan!');
    return;
  }
  
  groups.sort((a, b) => a.name.localeCompare(b.name));
  
  state.selectedBaseName = baseName;
  state.baseGroups = groups;
  state.selectedGroups = [];
  state.step = 'select_groups_in_base';
  state.currentPage = 0;
  
  await showDemoteGroupsInBase(chatId, userId, bot, userStates);
}

// Show groups in selected base name
async function showDemoteGroupsInBase(chatId, userId, bot, userStates) {
  const state = userStates[userId].adminFlow;
  const groupsPerPage = 8;
  
  const pagination = createPagination(state.currentPage, state.baseGroups.length, groupsPerPage);
  const pageGroups = state.baseGroups.slice(pagination.startIndex, pagination.endIndex);
  
  let message = `📋 *Grup "${state.selectedBaseName}"*\n\n`;
  message += `📄 Halaman ${pagination.currentPage + 1} dari ${pagination.totalPages}\n`;
  message += `✅ Terpilih: ${state.selectedGroups.length} grup\n\n`;
  
  const keyboard = [];
  
  pageGroups.forEach(group => {
    const isSelected = state.selectedGroups.includes(group.id);
    const icon = isSelected ? '✅' : '⭕';
    const adminStatus = group.isAdmin ? '👑' : '👤';
    
    keyboard.push([{
      text: `${icon} ${adminStatus} ${group.name}`,
      callback_data: `toggle_demote_all_group_${group.id}`
    }]);
  });
  
  const navButtons = [];
  if (pagination.hasPrev) {
    navButtons.push({ text: '◀️ Prev', callback_data: `demote_all_groups_page_${pagination.currentPage - 1}` });
  }
  if (pagination.hasNext) {
    navButtons.push({ text: 'Next ▶️', callback_data: `demote_all_groups_page_${pagination.currentPage + 1}` });
  }
  if (navButtons.length > 0) {
    keyboard.push(navButtons);
  }
  
  if (state.selectedGroups.length > 0) {
    keyboard.push([{ text: `🚀 Demote Admin di ${state.selectedGroups.length} Grup`, callback_data: 'confirm_demote_all_flow' }]);
  }
  
  keyboard.push([{ text: '🔙 Kembali', callback_data: 'demote_admin' }]);
  keyboard.push([{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]);
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Handle toggle group selection
async function handleToggleDemoteAllGroupSelection(chatId, userId, groupId, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_all') return;
  
  const index = state.selectedGroups.indexOf(groupId);
  if (index > -1) {
    state.selectedGroups.splice(index, 1);
  } else {
    state.selectedGroups.push(groupId);
  }
  
  await showDemoteGroupsInBase(chatId, userId, bot, userStates);
}

// Handle page navigation
async function handleDemoteAllGroupsPage(chatId, userId, page, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_all') return;
  
  if (state.step === 'select_base_names') {
    state.currentPage = page;
    await showDemoteBaseNamesList(chatId, userId, bot, userStates, messageId);
  } else if (state.step === 'select_groups_in_base') {
    state.currentPage = page;
    await showDemoteGroupsInBase(chatId, userId, bot, userStates);
  }
}

// Handle confirm demote all flow
async function handleConfirmDemoteAllFlow(chatId, userId, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_all' || state.selectedGroups.length === 0) {
    await bot.sendMessage(chatId, '❌ Pilih minimal 1 grup untuk demote admin!');
    return;
  }
  
  const selectedGroupsData = state.baseGroups.filter(group => 
    state.selectedGroups.includes(group.id)
  );
  
  let message = `🔍 **Konfirmasi Demote Semua Admin**\n\n`;
  message += `⚠️ Semua admin (kecuali superadmin) akan di-demote di grup berikut:\n\n`;
  
  selectedGroupsData.forEach((group, index) => {
    const adminStatus = group.isAdmin ? '👑' : '👤';
    message += `${index + 1}. ${adminStatus} ${group.name}\n`;
  });
  
  message += `\n📊 **Total: ${selectedGroupsData.length} grup**\n\n`;
  message += `⚠️ **Proses ini akan:**\n`;
  message += `• Demote semua admin (kecuali superadmin)\n`;
  message += `• Tidak bisa dibatalkan setelah dimulai!\n`;
  message += `• Membutuhkan bot jadi admin di grup`;
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Lanjutkan Demote Semua Admin', callback_data: 'confirm_demote_all_execute' }],
        [{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]
      ]
    }
  });
}

// Execute demote all
async function handleExecuteDemoteAllFlow(chatId, userId, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_all') return;
  
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Memulai proses demote semua admin...');
  
  try {
    const selectedGroupsData = state.baseGroups.filter(group => 
      state.selectedGroups.includes(group.id)
    );
    
    let statusMessage = '';
    let successCount = 0;
    let failCount = 0;
    let totalProcessed = 0;
    
    for (const group of selectedGroupsData) {
      totalProcessed++;
      statusMessage += `\n📂 **${group.name}:**\n`;
      
      try {
        if (!group.isAdmin) {
          statusMessage += `   ⚠️ Bot bukan admin - skip\n`;
          failCount++;
          continue;
        }
        
        const admins = await getGroupAdmins(userId, group.id);
        const regularAdmins = admins.filter(admin => admin.admin === 'admin');
        
        if (regularAdmins.length === 0) {
          statusMessage += `   ℹ️ Tidak ada admin biasa untuk di-demote\n`;
          continue;
        }
        
        statusMessage += `   📋 Ditemukan ${regularAdmins.length} admin biasa\n`;
        
        for (const admin of regularAdmins) {
          try {
            const phoneNumber = extractCleanPhoneNumberForAdmin(admin.id, userStates, userId);
            await demoteParticipant(userId, group.id, phoneNumber);
            statusMessage += `   ⬇️ Demoted ${phoneNumber}\n`;
            successCount++;
            
            await sleep(2000);
            
          } catch (demoteErr) {
            const phoneNumber = extractCleanPhoneNumberForAdmin(admin.id, userStates, userId);
            statusMessage += `   ❌ Error demoting ${phoneNumber}: ${demoteErr.message}\n`;
            failCount++;
          }
        }
        
        const progressMsg = generateProgressMessage(totalProcessed, selectedGroupsData.length, statusMessage, 'Demote All Admins');
        await safeEditMessage(bot, chatId, loadingMsg.message_id, progressMsg);
        
        await sleep(3000);
        
      } catch (err) {
        statusMessage += `   ❌ Error processing group: ${err.message}\n`;
        failCount++;
        
        if (isRateLimitError(err)) {
          await sleep(10000);
        }
      }
    }
    
    let finalMessage = `🎉 *Proses Demote Semua Admin Selesai!*\n\n`;
    finalMessage += `✅ Berhasil: ${successCount}\n`;
    finalMessage += `❌ Gagal: ${failCount}\n`;
    finalMessage += `📊 Grup diproses: ${totalProcessed}\n\n`;
    finalMessage += `*Detail:*\n${statusMessage}`;
    
    await safeEditMessage(bot, chatId, loadingMsg.message_id, finalMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👥 Admin Management', callback_data: 'admin_management' }],
          [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
        ]
      }
    });
    
  } catch (err) {
    console.error('Error in demote all process:', err);
    await safeEditMessage(bot, chatId, loadingMsg.message_id, `❌ Error dalam proses demote all: ${err.message}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
        ]
      }
    });
  }
  
  clearUserFlowState(userStates, userId, 'admin');
}

// ADD/PROMOTE ADMIN FUNCTIONS (keeping the original ones)
async function handleAddPromoteAdmin(chatId, userId, bot, userStates) {
  if (!userStates[userId]?.whatsapp?.isConnected) {
    await bot.sendMessage(chatId, '❌ WhatsApp belum terhubung! Login dulu ya.');
    return;
  }
  
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Mengambil daftar grup...');
  
  try {
    const groups = await getAllGroups(userId);
    
    if (!groups || groups.length === 0) {
      await safeEditMessage(bot, chatId, loadingMsg.message_id, '❌ Tidak ada grup yang ditemukan!', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }
    
    userStates[userId].adminFlow = {
      type: 'add_promote',
      step: 'select_groups',
      groups: groups,
      selectedGroups: [],
      currentPage: 0,
      searchQuery: '',
      adminsToAdd: []
    };
    
    await showGroupsList(chatId, userId, bot, userStates, loadingMsg.message_id);
    
  } catch (err) {
    console.error('Error getting groups:', err);
    await safeEditMessage(bot, chatId, loadingMsg.message_id, `❌ Error mengambil daftar grup: ${err.message}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
        ]
      }
    });
  }
}

async function showGroupsList(chatId, userId, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  const groupsPerPage = 8;
  
  let filteredGroups = state.groups;
  if (state.searchQuery) {
    filteredGroups = state.groups.filter(group => 
      group.name.toLowerCase().includes(state.searchQuery.toLowerCase())
    );
  }
  
  const pagination = createPagination(state.currentPage, filteredGroups.length, groupsPerPage);
  const pageGroups = filteredGroups.slice(pagination.startIndex, pagination.endIndex);
  
  let message = `📋 *Pilih Grup untuk Add/Promote Admin*\n\n`;
  
  if (state.searchQuery) {
    message += `🔍 Pencarian: "${state.searchQuery}"\n`;
    message += `📊 Hasil: ${filteredGroups.length} grup\n\n`;
  }
  
  message += `📄 Halaman ${pagination.currentPage + 1} dari ${pagination.totalPages}\n`;
  message += `✅ Terpilih: ${state.selectedGroups.length} grup\n\n`;
  
  const keyboard = [];
  
  pageGroups.forEach(group => {
    const isSelected = state.selectedGroups.includes(group.id);
    const icon = isSelected ? '✅' : '⭕';
    const adminStatus = group.isAdmin ? '👑' : '👤';
    
    keyboard.push([{
      text: `${icon} ${adminStatus} ${group.name}`,
      callback_data: `toggle_group_${group.id}`
    }]);
  });
  
  const navButtons = [];
  if (pagination.hasPrev) {
    navButtons.push({ text: '◀️ Prev', callback_data: `groups_page_${pagination.currentPage - 1}` });
  }
  if (pagination.hasNext) {
    navButtons.push({ text: 'Next ▶️', callback_data: `groups_page_${pagination.currentPage + 1}` });
  }
  if (navButtons.length > 0) {
    keyboard.push(navButtons);
  }
  
  keyboard.push([{ text: '🔍 Cari Grup', callback_data: 'search_groups' }]);
  
  if (state.selectedGroups.length > 0) {
    keyboard.push([{ text: '✅ Selesai', callback_data: 'finish_group_selection' }]);
  }
  
  keyboard.push([{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]);
  
  await safeEditMessage(bot, chatId, messageId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function handleToggleGroupSelection(chatId, userId, groupId, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'add_promote') return;
  
  const index = state.selectedGroups.indexOf(groupId);
  if (index > -1) {
    state.selectedGroups.splice(index, 1);
  } else {
    state.selectedGroups.push(groupId);
  }
  
  await showGroupsList(chatId, userId, bot, userStates, messageId);
}

async function handleGroupsPage(chatId, userId, page, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'add_promote') return;
  
  state.currentPage = page;
  await showGroupsList(chatId, userId, bot, userStates, messageId);
}

async function handleSearchGroups(chatId, userId, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'add_promote') return;
  
  state.step = 'waiting_search_query';
  
  await bot.sendMessage(chatId, '🔍 *Cari Grup*\n\nKetik nama grup yang mau dicari:', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]
      ]
    }
  });
}

async function handleFinishGroupSelection(chatId, userId, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'add_promote') return;
  
  state.step = 'waiting_admin_numbers';
  
  const selectedGroupNames = state.selectedGroups.map(groupId => {
    const group = state.groups.find(g => g.id === groupId);
    return group ? group.name : 'Unknown';
  });
  
  let message = `📝 *Input Nomor Admin*\n\n`;
  message += `✅ Grup terpilih (${state.selectedGroups.length}):\n`;
  selectedGroupNames.forEach((name, index) => {
    message += `${index + 1}. ${name}\n`;
  });
  message += `\n💬 Ketik nomor admin yang mau di-add/promote:\n\n`;
  message += `**Format:**\n`;
  message += `62812345\n`;
  message += `6213456\n`;
  message += `62987654\n\n`;
  message += `*(Satu nomor per baris, tanpa + atau spasi)*`;
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]
      ]
    }
  });
}

async function handleAdminNumbersForAddPromote(chatId, userId, phoneNumbers, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  state.adminsToAdd = phoneNumbers;
  state.step = 'confirm_add_promote';
  
  const selectedGroupNames = state.selectedGroups.map(groupId => {
    const group = state.groups.find(g => g.id === groupId);
    return group ? group.name : 'Unknown';
  });
  
  let message = `🔍 *Konfirmasi Add/Promote Admin*\n\n`;
  message += `👥 **Admin yang akan di-add/promote:**\n`;
  phoneNumbers.forEach((number, index) => {
    message += `${index + 1}. ${number}\n`;
  });
  message += `\n📂 **Grup tujuan (${state.selectedGroups.length}):**\n`;
  selectedGroupNames.forEach((name, index) => {
    message += `${index + 1}. ${name}\n`;
  });
  message += `\n⚠️ Proses ini tidak bisa dibatalkan!\n`;
  message += `ℹ️ Jika admin belum ada di grup, akan di-add dulu kemudian di-promote.`;
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Lanjutkan Add/Promote', callback_data: 'confirm_add_promote' }],
        [{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]
      ]
    }
  });
}

async function handleConfirmAddPromote(chatId, userId, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'add_promote') return;
  
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Memulai proses add/promote admin...');
  
  try {
    let statusMessage = '';
    let successCount = 0;
    let failCount = 0;
    let totalOperations = state.selectedGroups.length * state.adminsToAdd.length;
    let currentOperation = 0;
    
    for (const groupId of state.selectedGroups) {
      const group = state.groups.find(g => g.id === groupId);
      const groupName = group?.name || 'Unknown';
      
      statusMessage += `\n📂 **${groupName}:**\n`;
      
      for (const adminNumber of state.adminsToAdd) {
        currentOperation++;
        
        try {
          // Step 1: Check if participant is already in group
          const isInGroup = await isParticipantInGroup(userId, groupId, adminNumber);
          
          if (!isInGroup) {
            // Add participant first
            try {
              console.log(`[DEBUG][${userId}] Adding ${adminNumber} to group ${groupId}`);
              await addParticipantToGroup(userId, groupId, adminNumber);
              statusMessage += `   ✅ Added ${adminNumber}\n`;
              
              // Wait for WhatsApp to sync the participant
              console.log(`[DEBUG][${userId}] Waiting 15 seconds for group sync after adding ${adminNumber}...`);
              await sleep(15000);
              
            } catch (addErr) {
              // If participant already exists (409), just continue to promote
              if (addErr.message.includes('409') || addErr.message.includes('sudah ada')) {
                statusMessage += `   ℹ️ ${adminNumber} already in group\n`;
              } else {
                throw addErr;
              }
            }
          } else {
            statusMessage += `   ℹ️ ${adminNumber} already in group\n`;
          }
          
          // Step 2: Promote to admin with retry mechanism
          let promoteSuccess = false;
          let promoteAttempts = 0;
          const maxPromoteAttempts = 5;
          
          while (!promoteSuccess && promoteAttempts < maxPromoteAttempts) {
            promoteAttempts++;
            
            try {
              console.log(`[DEBUG][${userId}] Promote attempt ${promoteAttempts}/${maxPromoteAttempts} for ${adminNumber}`);
              
              // Double check if participant is really in group before promoting
              const isStillInGroup = await isParticipantInGroup(userId, groupId, adminNumber);
              if (!isStillInGroup) {
                console.log(`[DEBUG][${userId}] Participant ${adminNumber} not found in group, waiting more...`);
                await sleep(10000);
                continue;
              }
              
              await promoteParticipant(userId, groupId, adminNumber);
              promoteSuccess = true;
              statusMessage += `   👑 Promoted ${adminNumber} to admin\n`;
              successCount++;
              
            } catch (promoteErr) {
              console.log(`[DEBUG][${userId}] Promote attempt ${promoteAttempts} failed: ${promoteErr.message}`);
              
              if (promoteAttempts < maxPromoteAttempts) {
                // Exponential backoff: wait longer on each retry
                const waitTime = promoteAttempts * 5000; // 5s, 10s, 15s, 20s
                console.log(`[DEBUG][${userId}] Waiting ${waitTime/1000} seconds before retry...`);
                await sleep(waitTime);
              } else {
                // Final attempt failed
                throw promoteErr;
              }
            }
          }
          
          // Update progress
          const progressMsg = generateProgressMessage(currentOperation, totalOperations, statusMessage, 'Add/Promote');
          await safeEditMessage(bot, chatId, loadingMsg.message_id, progressMsg);
          
          // Delay between operations to avoid rate limits
          await sleep(5000);
          
        } catch (err) {
          failCount++;
          statusMessage += `   ❌ Error ${adminNumber}: ${err.message}\n`;
          console.error(`Error adding/promoting ${adminNumber} in ${groupId}:`, err);
          
          // If rate limit, wait much longer
          if (isRateLimitError(err)) {
            console.log(`[DEBUG][${userId}] Rate limit detected, waiting 30 seconds...`);
            await sleep(30000);
          }
        }
      }
    }
    
    // Final result
    let finalMessage = `🎉 *Proses Add/Promote Admin Selesai!*\n\n`;
    finalMessage += `✅ Berhasil: ${successCount}\n`;
    finalMessage += `❌ Gagal: ${failCount}\n\n`;
    finalMessage += `*Detail:*\n${statusMessage}`;
    
    await safeEditMessage(bot, chatId, loadingMsg.message_id, finalMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👥 Admin Management', callback_data: 'admin_management' }],
          [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
        ]
      }
    });
    
  } catch (err) {
    console.error('Error in add/promote process:', err);
    await safeEditMessage(bot, chatId, loadingMsg.message_id, `❌ Error dalam proses add/promote: ${err.message}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
        ]
      }
    });
  }
  
  // Clear admin flow state
  clearUserFlowState(userStates, userId, 'admin');
}

// Handle cancel admin flow
async function handleCancelAdminFlow(chatId, userId, bot, userStates) {
  // Clear admin flow state
  clearUserFlowState(userStates, userId, 'admin');
  
  await bot.sendMessage(chatId, '✅ Proses admin management dibatalkan!');
  await showAdminManagementMenu(chatId, bot);
}

module.exports = {
  handleAdminCallbacks,
  handleAdminMessages
};
