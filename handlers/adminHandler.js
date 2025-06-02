const { 
  getAllGroups,
  addParticipantToGroup,
  promoteParticipant,
  demoteParticipant,
  getGroupAdmins,
  isParticipantInGroup,
  globalLIDMapper,
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

// IMPROVED: Helper function to extract clean phone number from JID/LID
function extractCleanPhoneNumberForAdmin(jid, userStates = null, userId = null) {
  if (!jid) return 'Unknown';
  
  // Remove device suffix (:0, :1, etc) first
  let cleanJid = jid.split(':')[0] + '@' + jid.split('@')[1];
  
  // Remove domain (@s.whatsapp.net or @lid)
  let identifier = cleanJid.split('@')[0];
  
  console.log(`[DEBUG] Extracting phone from: ${jid} → identifier: ${identifier}`);
  
  // Case 1: Regular WhatsApp number format (@s.whatsapp.net)
  if (jid.includes('@s.whatsapp.net')) {
    // Handle Indonesian format starting with 0
    if (identifier.startsWith('0') && identifier.length > 10) {
      const phoneNumber = '62' + identifier.substring(1);
      console.log(`[DEBUG] Converted 0xxx to 62xxx: ${phoneNumber}`);
      return phoneNumber;
    }
    console.log(`[DEBUG] Regular JID format: ${identifier}`);
    return identifier;
  }
  
  // Case 2: LID format (@lid) - Need special handling
  if (jid.includes('@lid')) {
    // Check global LID mapper first
    if (typeof globalLIDMapper !== 'undefined') {
      const mapped = globalLIDMapper.getPhoneFromLID(jid);
      if (mapped) {
        console.log(`[DEBUG] Found LID mapping: ${jid} → ${mapped}`);
        return mapped;
      }
    }
    
    // Try to get the associated phone number from bot user info
    if (userStates && userId && userStates[userId]?.whatsapp?.socket?.user) {
      const botUser = userStates[userId].whatsapp.socket.user;
      
      // Check if this LID belongs to the bot itself
      if (botUser.lid && botUser.lid.includes(identifier)) {
        const botPhoneFromJid = botUser.id.split('@')[0].split(':')[0];
        console.log(`[DEBUG] LID belongs to bot, using bot phone: ${botPhoneFromJid}`);
        return botPhoneFromJid;
      }
    }
    
    // For other LIDs, try various conversion methods
    console.log(`[DEBUG] Processing LID: ${identifier}, length: ${identifier.length}`);
    
    // Method 1: Try to extract Indonesian phone pattern from LID
    if (identifier.length >= 12) {
      // Try different patterns for Indonesian numbers
      const patterns = [
        identifier.substring(0, 12), // Take first 12 digits
        identifier.substring(0, 13), // Take first 13 digits
        identifier.substring(1, 13), // Skip first digit, take next 12
        identifier.substring(2, 14), // Skip first 2 digits, take next 12
      ];
      
      for (const pattern of patterns) {
        // Check if it looks like Indonesian number (starts with 62 or could be 62xxx)
        if (pattern.startsWith('62') && pattern.length >= 11 && pattern.length <= 13) {
          console.log(`[DEBUG] Found Indonesian pattern in LID: ${pattern}`);
          return pattern;
        }
        
        // Try adding 62 prefix if pattern looks like local Indonesian number
        if (pattern.startsWith('8') && pattern.length >= 9 && pattern.length <= 11) {
          const withPrefix = '62' + pattern;
          console.log(`[DEBUG] Added 62 prefix to LID pattern: ${withPrefix}`);
          return withPrefix;
        }
      }
    }
    
    // Method 2: Use a more aggressive approach for LID conversion
    // Extract all digits and try to find phone pattern
    const allDigits = identifier.replace(/\D/g, ''); // Remove non-digits
    
    if (allDigits.length >= 10) {
      // Try to find 62XXXXXXXXX pattern (Indonesian format)
      const match62 = allDigits.match(/62\d{8,11}/);
      if (match62) {
        console.log(`[DEBUG] Found 62xxx pattern in LID: ${match62[0]}`);
        return match62[0];
      }
      
      // Try to find 8XXXXXXXX pattern (Indonesian without country code)
      const match8 = allDigits.match(/8\d{7,10}/);
      if (match8) {
        const withPrefix = '62' + match8[0];
        console.log(`[DEBUG] Found 8xxx pattern, added prefix: ${withPrefix}`);
        return withPrefix;
      }
      
      // Fallback: take first reasonable phone length
      if (allDigits.length >= 10 && allDigits.length <= 15) {
        console.log(`[DEBUG] Using fallback LID conversion: ${allDigits}`);
        return allDigits.substring(0, 12); // Limit to 12 digits
      }
    }
    
    // Final fallback for LID: use original identifier but truncated
    console.log(`[DEBUG] LID fallback: ${identifier.substring(0, 12)}`);
    return identifier.substring(0, 12);
  }
  
  // Fallback for any other format
  console.log(`[DEBUG] Unknown format fallback: ${identifier}`);
  return identifier;
}

// UPDATED: Function to get display name for admin with improved phone extraction
function getAdminDisplayName(admin, userStates = null, userId = null) {
  const phoneNumber = extractCleanPhoneNumberForAdmin(admin.id, userStates, userId);
  const role = admin.admin === 'superadmin' ? '👑' : '👤';
  
  return `${role} ${phoneNumber}`;
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
        
      // NEW DEMOTE FLOW - START
      case data === 'demote_admin':
        await handleDemoteAdminNew(chatId, userId, bot, userStates);
        break;
        
      case data === 'search_admin_in_all_groups':
        await handleSearchAdminInAllGroups(chatId, userId, bot, userStates);
        break;
        
      case data === 'confirm_demote_from_selected_groups':
        await handleConfirmDemoteFromSelectedGroups(chatId, userId, bot, userStates);
        break;

      case data === 'confirm_demote_new':
        await handleConfirmDemoteNew(chatId, userId, bot, userStates);
        break;
        
      case data.startsWith('toggle_demote_group_'):
        const demoteGroupId = data.replace('toggle_demote_group_', '');
        await handleToggleDemoteGroupSelection(chatId, userId, demoteGroupId, bot, userStates, query.message.message_id);
        break;
        
      case data.startsWith('demote_groups_page_'):
        const demoteGroupPage = parseInt(data.replace('demote_groups_page_', ''));
        await handleDemoteGroupsPage(chatId, userId, demoteGroupPage, bot, userStates, query.message.message_id);
        break;
      // NEW DEMOTE FLOW - END
        
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
        const groupId = data.replace('toggle_group_', '');
        await handleToggleGroupSelection(chatId, userId, groupId, bot, userStates, query.message.message_id);
        break;
        
      case data.startsWith('groups_page_'):
        const page = parseInt(data.replace('groups_page_', ''));
        await handleGroupsPage(chatId, userId, page, bot, userStates, query.message.message_id);
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
  
  // Handle admin flow input
  if (userStates[userId]?.adminFlow) {
    const state = userStates[userId].adminFlow;
    
    if (state.step === 'waiting_search_query' && state.type === 'add_promote') {
      // Delete user's message
      await safeDeleteMessage(bot, chatId, msg.message_id);
      
      state.searchQuery = text.trim();
      state.currentPage = 0;
      state.step = 'select_groups';
      
      const loadingMsg = await bot.sendMessage(chatId, '⏳ Mencari grup...');
      await showGroupsList(chatId, userId, bot, userStates, loadingMsg.message_id);
      return true;
    }
    
    // NEW DEMOTE FLOW - Handle admin numbers input
    if (state.step === 'waiting_admin_numbers' && state.type === 'demote_new') {
      // Delete user's message
      await safeDeleteMessage(bot, chatId, msg.message_id);
      
      // Parse admin numbers
      const { phoneNumbers, errors } = parsePhoneNumbers(text);
      
      if (errors.length > 0) {
        await bot.sendMessage(chatId, `❌ ${errors.join('\n')}\n\nFormat harus 10-15 digit angka saja, tanpa + atau spasi.`);
        return true;
      }
      
      if (phoneNumbers.length === 0) {
        await bot.sendMessage(chatId, '❌ Tidak ada nomor admin yang valid!');
        return true;
      }
      
      state.adminNumbers = phoneNumbers;
      state.step = 'confirm_search';
      
      // Show confirmation with search button
      let message = `👥 **Admin yang akan dicari:**\n`;
      phoneNumbers.forEach((number, index) => {
        message += `${index + 1}. ${number}\n`;
      });
      message += `\n🔍 Klik tombol di bawah untuk mulai mencari admin di semua grup.`;
      
      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 Cari Admin di Semua Grup', callback_data: 'search_admin_in_all_groups' }],
            [{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]
          ]
        }
      });
      return true;
    }
    
    if (state.step === 'waiting_admin_numbers') {
      // Delete user's message
      await safeDeleteMessage(bot, chatId, msg.message_id);
      
      // Parse admin numbers
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
  
  return false; // Not handled
}

// NEW DEMOTE FLOW - Handle Demote Admin (New Flow)
async function handleDemoteAdminNew(chatId, userId, bot, userStates) {
  // Check if WhatsApp is connected
  if (!userStates[userId]?.whatsapp?.isConnected) {
    await bot.sendMessage(chatId, '❌ WhatsApp belum terhubung! Login dulu ya.');
    return;
  }
  
  // Initialize new demote flow state
  userStates[userId].adminFlow = {
    type: 'demote_new',
    step: 'waiting_admin_numbers',
    adminNumbers: [],
    foundGroups: [],
    selectedGroups: [],
    currentPage: 0
  };
  
  console.log(`[DEBUG][DEMOTE_NEW] Initialized new demote flow for user ${userId}`);
  
  const message = `📝 *Input Nomor Admin yang Mau Di-Demote*\n\n`;
  const instructions = `💬 Ketik nomor admin yang mau di-demote:\n\n`;
  const format = `**Format:**\n62812345\n6213456\n62987654\n\n*(Satu nomor per baris, tanpa + atau spasi)*`;
  
  await bot.sendMessage(chatId, message + instructions + format, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]
      ]
    }
  });
}

// NEW DEMOTE FLOW - Search admin in all groups
async function handleSearchAdminInAllGroups(chatId, userId, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_new' || !state.adminNumbers || state.adminNumbers.length === 0) {
    await bot.sendMessage(chatId, '❌ Tidak ada nomor admin yang valid untuk dicari.');
    return;
  }
  
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Mencari admin di semua grup...');
  
  try {
    console.log(`[DEBUG][DEMOTE_NEW] Searching admins in all groups for: ${state.adminNumbers.join(', ')}`);
    
    const groups = await getAllGroups(userId);
    const foundResults = [];
    
    for (const group of groups) {
      try {
        console.log(`[DEBUG][DEMOTE_NEW] Checking group: ${group.name} (${group.id})`);
        
        const admins = await getGroupAdmins(userId, group.id);
        console.log(`[DEBUG][DEMOTE_NEW] Found ${admins.length} admins in group ${group.name}`);
        
        const groupFoundAdmins = [];
        
        for (const adminNumber of state.adminNumbers) {
          console.log(`[DEBUG][DEMOTE_NEW] Looking for admin number: ${adminNumber}`);
          
          // Method 1: Direct JID matching
          const directJid = `${adminNumber}@s.whatsapp.net`;
          const directLid = `${adminNumber}@lid`;
          
          let foundAdmin = admins.find(admin => 
            admin.id === directJid || admin.id === directLid
          );
          
          if (foundAdmin) {
            console.log(`[DEBUG][DEMOTE_NEW] Found via direct JID: ${foundAdmin.id}`);
            groupFoundAdmins.push({
              number: adminNumber,
              jid: foundAdmin.id,
              role: foundAdmin.admin,
              method: 'direct_jid'
            });
            continue;
          }
          
          // Method 2: Extract phone number and compare
          for (const admin of admins) {
            const extractedPhone = extractCleanPhoneNumberForAdmin(admin.id, userStates, userId);
            console.log(`[DEBUG][DEMOTE_NEW] Comparing ${adminNumber} with extracted ${extractedPhone} from ${admin.id}`);
            
            if (extractedPhone === adminNumber) {
              console.log(`[DEBUG][DEMOTE_NEW] Found via phone extraction: ${admin.id} → ${extractedPhone}`);
              groupFoundAdmins.push({
                number: adminNumber,
                jid: admin.id,
                role: admin.admin,
                method: 'phone_extraction'
              });
              break;
            }
            
            // Also try partial matching (last 8 digits)
            const last8Admin = adminNumber.slice(-8);
            const last8Extracted = extractedPhone.slice(-8);
            
            if (last8Admin === last8Extracted && last8Admin.length === 8) {
              console.log(`[DEBUG][DEMOTE_NEW] Found via last 8 digits: ${admin.id} → ${extractedPhone}`);
              groupFoundAdmins.push({
                number: adminNumber,
                jid: admin.id,
                role: admin.admin,
                method: 'partial_match'
              });
              break;
            }
          }
          
          // Method 3: Try LID mapping if available
          if (!foundAdmin && typeof globalLIDMapper !== 'undefined') {
            for (const admin of admins) {
              if (admin.id.includes('@lid')) {
                const mappedPhone = globalLIDMapper.getPhoneFromLID(admin.id, group.id);
                if (mappedPhone === adminNumber) {
                  console.log(`[DEBUG][DEMOTE_NEW] Found via LID mapping: ${admin.id} → ${mappedPhone}`);
                  groupFoundAdmins.push({
                    number: adminNumber,
                    jid: admin.id,
                    role: admin.admin,
                    method: 'lid_mapping'
                  });
                  break;
                }
              }
            }
          }
        }
        
        if (groupFoundAdmins.length > 0) {
          foundResults.push({
            groupId: group.id,
            groupName: group.name,
            foundAdmins: groupFoundAdmins
          });
          console.log(`[DEBUG][DEMOTE_NEW] Group ${group.name}: Found ${groupFoundAdmins.length} matching admins`);
        }
        
      } catch (err) {
        console.error(`[DEBUG][DEMOTE_NEW] Error checking group ${group.id}:`, err);
      }
    }
    
    state.foundGroups = foundResults;
    state.selectedGroups = [];
    state.step = 'select_groups_to_demote';
    state.currentPage = 0;
    
    if (foundResults.length === 0) {
      await safeEditMessage(bot, chatId, loadingMsg.message_id, 
        `❌ **Admin tidak ditemukan!**\n\nAdmin dengan nomor berikut tidak ditemukan di grup manapun:\n${state.adminNumbers.map(n => `• ${n}`).join('\n')}\n\nPastikan:\n• Nomor sudah benar\n• Admin masih ada di grup\n• Bot memiliki akses ke grup`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
            ]
          }
        }
      );
      return;
    }
    
    await showFoundGroupsForDemote(chatId, userId, bot, userStates, loadingMsg.message_id);
    
  } catch (err) {
    console.error('Error searching admins:', err);
    await safeEditMessage(bot, chatId, loadingMsg.message_id, `❌ Error mencari admin: ${err.message}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
        ]
      }
    });
  }
}

// NEW DEMOTE FLOW - Show found groups for demote with pagination
async function showFoundGroupsForDemote(chatId, userId, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  const groupsPerPage = 5; // 5 groups per page for better readability
  
  const pagination = createPagination(state.currentPage, state.foundGroups.length, groupsPerPage);
  const pageGroups = state.foundGroups.slice(pagination.startIndex, pagination.endIndex);
  
  let message = `🎯 **Admin Ditemukan di ${state.foundGroups.length} Grup**\n\n`;
  message += `📞 **Nomor yang dicari:**\n${state.adminNumbers.map(n => `• ${n}`).join('\n')}\n\n`;
  message += `📄 Halaman ${pagination.currentPage + 1} dari ${pagination.totalPages}\n`;
  message += `✅ Terpilih: ${state.selectedGroups.length} grup\n\n`;
  
  const keyboard = [];
  
  // Groups with found admins
  pageGroups.forEach((result, index) => {
    const isSelected = state.selectedGroups.includes(result.groupId);
    const icon = isSelected ? '✅' : '⭕';
    
    // Group button
    keyboard.push([{
      text: `${icon} ${result.groupName}`,
      callback_data: `toggle_demote_group_${result.groupId}`
    }]);
    
    // Show found admins in this group
    result.foundAdmins.forEach(admin => {
      const roleIcon = admin.role === 'superadmin' ? '👑' : '👤';
      const methodText = admin.method === 'direct_jid' ? 'Direct' : 
                        admin.method === 'phone_extraction' ? 'Phone' :
                        admin.method === 'lid_mapping' ? 'LID' : 'Partial';
      
      keyboard.push([{
        text: `  ${roleIcon} ${admin.number} (${methodText})`,
        callback_data: 'noop'
      }]);
    });
    
    // Add separator if not last item
    if (index < pageGroups.length - 1) {
      keyboard.push([{
        text: '────────────',
        callback_data: 'noop'
      }]);
    }
  });
  
  // Navigation buttons
  const navButtons = [];
  if (pagination.hasPrev) {
    navButtons.push({ text: '◀️ Prev', callback_data: `demote_groups_page_${pagination.currentPage - 1}` });
  }
  if (pagination.hasNext) {
    navButtons.push({ text: 'Next ▶️', callback_data: `demote_groups_page_${pagination.currentPage + 1}` });
  }
  if (navButtons.length > 0) {
    keyboard.push(navButtons);
  }
  
  // Action buttons
  if (state.selectedGroups.length > 0) {
    keyboard.push([{ text: `🚀 Demote dari ${state.selectedGroups.length} Grup`, callback_data: 'confirm_demote_from_selected_groups' }]);
  }
  
  keyboard.push([{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]);
  
  await safeEditMessage(bot, chatId, messageId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// NEW DEMOTE FLOW - Handle toggle group selection for demote
async function handleToggleDemoteGroupSelection(chatId, userId, groupId, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_new') return;
  
  const index = state.selectedGroups.indexOf(groupId);
  if (index > -1) {
    state.selectedGroups.splice(index, 1);
    console.log(`[DEBUG][DEMOTE_NEW] Removed group ${groupId} from selection`);
  } else {
    state.selectedGroups.push(groupId);
    console.log(`[DEBUG][DEMOTE_NEW] Added group ${groupId} to selection`);
  }
  
  await showFoundGroupsForDemote(chatId, userId, bot, userStates, messageId);
}

// NEW DEMOTE FLOW - Handle page navigation for demote groups
async function handleDemoteGroupsPage(chatId, userId, page, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_new') return;
  
  state.currentPage = page;
  await showFoundGroupsForDemote(chatId, userId, bot, userStates, messageId);
}

// NEW DEMOTE FLOW - Handle confirm demote from selected groups
async function handleConfirmDemoteFromSelectedGroups(chatId, userId, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_new' || state.selectedGroups.length === 0) {
    await bot.sendMessage(chatId, '❌ Pilih minimal 1 grup untuk demote!');
    return;
  }
  
  // Prepare confirmation data
  const confirmData = [];
  
  for (const groupId of state.selectedGroups) {
    const groupResult = state.foundGroups.find(g => g.groupId === groupId);
    if (groupResult) {
      confirmData.push({
        groupId: groupResult.groupId,
        groupName: groupResult.groupName,
        admins: groupResult.foundAdmins
      });
    }
  }
  
  state.confirmData = confirmData;
  state.step = 'confirm_demote_new';
  
  let message = `🔍 **Konfirmasi Demote Admin**\n\n`;
  message += `⚠️ Admin berikut akan di-demote:\n\n`;
  
  confirmData.forEach((data, index) => {
    message += `${index + 1}. **${data.groupName}**\n`;
    data.admins.forEach(admin => {
      const roleIcon = admin.role === 'superadmin' ? '👑' : '👤';
      message += `   ${roleIcon} ${admin.number}\n`;
    });
    message += `\n`;
  });
  
  const totalAdmins = confirmData.reduce((sum, data) => sum + data.admins.length, 0);
  message += `📊 **Total: ${totalAdmins} admin di ${confirmData.length} grup**\n\n`;
  message += `⚠️ **Proses ini tidak bisa dibatalkan!**`;
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Lanjutkan Demote', callback_data: 'confirm_demote_new' }],
        [{ text: '❌ Batal', callback_data: 'cancel_admin_flow' }]
      ]
    }
  });
}

// Handle admin numbers for add/promote flow
async function handleAdminNumbersForAddPromote(chatId, userId, phoneNumbers, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  state.adminsToAdd = phoneNumbers;
  state.step = 'confirm_add_promote';
  
  // Show confirmation
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

// Handle Add/Promote Admin
async function handleAddPromoteAdmin(chatId, userId, bot, userStates) {
  // Check if WhatsApp is connected
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
    
    // Initialize admin flow state
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

// Show groups list with pagination
async function showGroupsList(chatId, userId, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  const groupsPerPage = 8;
  
  // Filter groups by search query
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
  
  // Groups buttons
  pageGroups.forEach(group => {
    const isSelected = state.selectedGroups.includes(group.id);
    const icon = isSelected ? '✅' : '⭕';
    const adminStatus = group.isAdmin ? '👑' : '👤';
    
    keyboard.push([{
      text: `${icon} ${adminStatus} ${group.name}`,
      callback_data: `toggle_group_${group.id}`
    }]);
  });
  
  // Navigation buttons
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
  
  // Action buttons
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

// Handle group selection toggle
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

// Handle groups page navigation
async function handleGroupsPage(chatId, userId, page, bot, userStates, messageId) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'add_promote') return;
  
  state.currentPage = page;
  await showGroupsList(chatId, userId, bot, userStates, messageId);
}

// Handle search groups
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

// Handle finish group selection
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

// Handle confirm add/promote - IMPROVED WITH BETTER TIMING
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
              
              // CRITICAL: Wait longer for WhatsApp to fully sync the participant
              console.log(`[DEBUG][${userId}] Waiting 15 seconds for group sync after adding ${adminNumber}...`);
              await sleep(15000); // Increased from 8 to 15 seconds
              
            } catch (addErr) {
              // If participant already exists (409), just continue to promote
              if (addErr.message.includes('409') || addErr.message.includes('sudah ada')) {
                statusMessage += `   ℹ️ ${adminNumber} already in group\n`;
              } else {
                throw addErr; // Re-throw other errors
              }
            }
          } else {
            statusMessage += `   ℹ️ ${adminNumber} already in group\n`;
          }
          
          // Step 2: Promote to admin with enhanced retry mechanism
          let promoteSuccess = false;
          let promoteAttempts = 0;
          const maxPromoteAttempts = 5; // Increased from 3 to 5
          
          while (!promoteSuccess && promoteAttempts < maxPromoteAttempts) {
            promoteAttempts++;
            
            try {
              console.log(`[DEBUG][${userId}] Promote attempt ${promoteAttempts}/${maxPromoteAttempts} for ${adminNumber}`);
              
              // Double check if participant is really in group before promoting
              const isStillInGroup = await isParticipantInGroup(userId, groupId, adminNumber);
              if (!isStillInGroup) {
                console.log(`[DEBUG][${userId}] Participant ${adminNumber} not found in group, waiting more...`);
                await sleep(10000); // Wait 10 more seconds
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
          await sleep(5000); // Increased from 3 to 5 seconds
          
        } catch (err) {
          failCount++;
          statusMessage += `   ❌ Error ${adminNumber}: ${err.message}\n`;
          console.error(`Error adding/promoting ${adminNumber} in ${groupId}:`, err);
          
          // If rate limit, wait much longer
          if (isRateLimitError(err)) {
            console.log(`[DEBUG][${userId}] Rate limit detected, waiting 30 seconds...`);
            await sleep(30000); // Increased from 10 to 30 seconds
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

// NEW DEMOTE FLOW - Handle confirm demote (new flow)
async function handleConfirmDemoteNew(chatId, userId, bot, userStates) {
  const state = userStates[userId].adminFlow;
  
  if (!state || state.type !== 'demote_new') return;
  
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Memulai proses demote admin...');
  
  try {
    let statusMessage = '';
    let successCount = 0;
    let failCount = 0;
    let totalOperations = 0;
    
    // Calculate total operations
    state.confirmData.forEach(data => {
      totalOperations += data.admins.length;
    });
    
    let currentOperation = 0;
    
    for (const data of state.confirmData) {
      statusMessage += `\n📂 **${data.groupName}:**\n`;
      
      for (const admin of data.admins) {
        currentOperation++;
        
        try {
          // Use the exact phone number from our search result
          await demoteParticipant(userId, data.groupId, admin.number);
          statusMessage += `   ⬇️ Demoted ${admin.number}\n`;
          successCount++;
          
          // Update progress
          const progressMsg = generateProgressMessage(currentOperation, totalOperations, statusMessage, 'Demote');
          await safeEditMessage(bot, chatId, loadingMsg.message_id, progressMsg);
          
          // Delay to avoid rate limit
          await sleep(3000);
          
        } catch (err) {
          failCount++;
          statusMessage += `   ❌ Error ${admin.number}: ${err.message}\n`;
          console.error(`Error demoting ${admin.number} in ${data.groupId}:`, err);
          
          // If rate limit, wait longer
          if (isRateLimitError(err)) {
            await sleep(10000);
          }
        }
      }
    }
    
    // Final result
    let finalMessage = `🎉 *Proses Demote Admin Selesai!*\n\n`;
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
    console.error('Error in demote process:', err);
    await safeEditMessage(bot, chatId, loadingMsg.message_id, `❌ Error dalam proses demote: ${err.message}`, {
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