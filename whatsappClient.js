const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { jidMapper, resolveActualJID, findParticipantInGroupWithMapping, isParticipantInGroupWithMapping } = require('./utils/jidMapper');

// Get userStates from index.js
function getUserStates() {
  return require('./index').userStates;
}

// LID to Phone Number Mapping System
class LIDPhoneMapper {
  constructor() {
    this.lidToPhoneMap = new Map();
    this.phoneToLidMap = new Map();
    this.groupMappings = new Map();
    this.loadMappingsFromFile();
  }

  loadMappingsFromFile() {
    try {
      const mappingFile = path.join(__dirname, 'lid_mappings.json');
      if (fs.existsSync(mappingFile)) {
        const data = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        if (data.global) {
          for (const [lid, phone] of Object.entries(data.global)) {
            this.lidToPhoneMap.set(lid, phone);
            this.phoneToLidMap.set(phone, lid);
          }
        }
        if (data.groups) {
          for (const [groupId, mappings] of Object.entries(data.groups)) {
            this.groupMappings.set(groupId, new Map(Object.entries(mappings)));
          }
        }
        console.log(`[LID_MAPPER] Loaded ${this.lidToPhoneMap.size} global mappings and ${this.groupMappings.size} group mappings`);
      }
    } catch (err) {
      console.error('[LID_MAPPER] Error loading mappings:', err);
    }
  }

  saveMappingsToFile() {
    try {
      const mappingFile = path.join(__dirname, 'lid_mappings.json');
      const data = {
        global: Object.fromEntries(this.lidToPhoneMap),
        groups: {}
      };
      for (const [groupId, mappings] of this.groupMappings.entries()) {
        data.groups[groupId] = Object.fromEntries(mappings);
      }
      fs.writeFileSync(mappingFile, JSON.stringify(data, null, 2));
      console.log(`[LID_MAPPER] Saved mappings to file`);
    } catch (err) {
      console.error('[LID_MAPPER] Error saving mappings:', err);
    }
  }

  addMapping(lid, phoneNumber, groupId = null) {
    const cleanLid = lid.includes('@') ? lid : `${lid}@lid`;
    const cleanPhone = phoneNumber.replace(/[^\d]/g, '');
    this.lidToPhoneMap.set(cleanLid, cleanPhone);
    this.phoneToLidMap.set(cleanPhone, cleanLid);
    if (groupId) {
      if (!this.groupMappings.has(groupId)) {
        this.groupMappings.set(groupId, new Map());
      }
      this.groupMappings.get(groupId).set(cleanLid, cleanPhone);
    }
    console.log(`[LID_MAPPER] Added mapping: ${cleanLid} ↔ ${cleanPhone} (group: ${groupId || 'global'})`);
    this.saveMappingsToFile();
  }

  getPhoneFromLID(lid, groupId = null) {
    const cleanLid = lid.includes('@') ? lid : `${lid}@lid`;
    if (groupId && this.groupMappings.has(groupId)) {
      const groupMap = this.groupMappings.get(groupId);
      if (groupMap.has(cleanLid)) {
        return groupMap.get(cleanLid);
      }
    }
    return this.lidToPhoneMap.get(cleanLid);
  }

  getLIDFromPhone(phoneNumber, groupId = null) {
    const cleanPhone = phoneNumber.replace(/[^\d]/g, '');
    if (groupId) {
      const groupMap = this.groupMappings.get(groupId);
      if (groupMap) {
        for (const [lid, phone] of groupMap.entries()) {
          if (phone === cleanPhone) {
            return lid;
          }
        }
      }
    }
    return this.phoneToLidMap.get(cleanPhone);
  }

  correlateGroupParticipants(userStates, userId, groupMetadata) {
    if (!groupMetadata || !groupMetadata.participants) return;
    const groupId = groupMetadata.id;
    const lidParticipants = groupMetadata.participants.filter(p => p.id.includes('@lid'));
    const regularParticipants = groupMetadata.participants.filter(p => p.id.includes('@s.whatsapp.net'));
    console.log(`[LID_MAPPER] Correlating group ${groupId}: ${lidParticipants.length} LID, ${regularParticipants.length} regular`);
    if (lidParticipants.length > 0 && regularParticipants.length > 0) {
      const lidAdmins = lidParticipants.filter(p => p.admin);
      const regularAdmins = regularParticipants.filter(p => p.admin);
      if (lidAdmins.length === regularAdmins.length && lidAdmins.length === 1) {
        const lidAdmin = lidAdmins[0];
        const regularAdmin = regularAdmins[0];
        const phoneNumber = regularAdmin.id.split('@')[0].split(':')[0];
        this.addMapping(lidAdmin.id, phoneNumber, groupId);
        console.log(`[LID_MAPPER] Correlated admin: ${lidAdmin.id} → ${phoneNumber}`);
      }
    }
  }

  addPredefinedMappings() {
    console.log('[LID_MAPPER] Adding predefined mappings...');
    this.addMapping('59318229561477@lid', '6285753436471');
    this.addMapping('177829446709455@lid', '6283817954420');
    console.log('[LID_MAPPER] Predefined mappings added successfully!');
  }

  clearGroupMappings(groupId) {
    this.groupMappings.delete(groupId);
    this.saveMappingsToFile();
  }

  debugMappings() {
    console.log(`[LID_MAPPER] Global mappings:`);
    for (const [lid, phone] of this.lidToPhoneMap.entries()) {
      console.log(`  ${lid} → ${phone}`);
    }
  }
}

const globalLIDMapper = new LIDPhoneMapper();
globalLIDMapper.addPredefinedMappings();

function extractCleanPhoneNumber(jid, userStates = null, userId = null, groupId = null) {
  if (!jid) return 'Unknown';
  console.log(`[DEBUG] Extracting phone from: ${jid} (groupId: ${groupId})`);
  if (jid.includes('@s.whatsapp.net')) {
    let identifier = jid.split('@')[0].split(':')[0];
    if (identifier.startsWith('0') && identifier.length > 10) {
      const phoneNumber = '62' + identifier.substring(1);
      console.log(`[DEBUG] Converted 0xxx to 62xxx: ${phoneNumber}`);
      return phoneNumber;
    }
    console.log(`[DEBUG] Regular JID format: ${identifier}`);
    return identifier;
  }
  if (jid.includes('@lid')) {
    const mappedPhone = globalLIDMapper.getPhoneFromLID(jid, groupId);
    if (mappedPhone) {
      console.log(`[DEBUG] Found mapped phone for LID ${jid}: ${mappedPhone}`);
      return mappedPhone;
    }
    if (userStates && userId && userStates[userId]?.whatsapp?.socket?.user) {
      const botUser = userStates[userId].whatsapp.socket.user;
      const botLidBase = botUser.lid ? botUser.lid.split(':')[0] + '@lid' : null;
      if (botLidBase === jid) {
        const botPhoneFromJid = botUser.id.split('@')[0].split(':')[0];
        console.log(`[DEBUG] LID belongs to bot, using bot phone: ${botPhoneFromJid}`);
        globalLIDMapper.addMapping(jid, botPhoneFromJid, groupId);
        return botPhoneFromJid;
      }
    }
    const identifier = jid.split('@')[0].split(':')[0];
    console.log(`[DEBUG] No mapping found for LID: ${jid}, returning identifier: ${identifier}`);
    return `${identifier}[LID]`;
  }
  const identifier = jid.split('@')[0].split(':')[0];
  console.log(`[DEBUG] Unknown format fallback: ${identifier}`);
  return identifier;
}

async function discoverLIDMappings(userStates, userId, groupId) {
  try {
    const sock = userStates[userId]?.whatsapp?.socket;
    if (!sock) return;
    const groupMetadata = await sock.groupMetadata(groupId);
    globalLIDMapper.correlateGroupParticipants(userStates, userId, groupMetadata);
  } catch (err) {
    console.error(`[LID_MAPPER] Error discovering mappings for group ${groupId}:`, err);
  }
}

const reconnectAttempts = {};
const MAX_RECONNECT_ATTEMPTS = 3;

function isBotAdminInGroup(groupMetadata, botJid, botLid) {
  if (!groupMetadata || !groupMetadata.participants) return false;
  const botNumber = botJid.split('@')[0].split(':')[0];
  const botLidNumber = botLid ? botLid.split('@')[0].split(':')[0] : null;
  console.log(`[DEBUG] Checking admin status:`);
  console.log(`[DEBUG] - Bot JID: ${botJid}, Bot LID: ${botLid}`);
  console.log(`[DEBUG] - Bot numbers: ${botNumber}, ${botLidNumber}`);
  const isAdmin = groupMetadata.participants.some(p => {
    const hasAdminRole = p.admin === 'admin' || p.admin === 'superadmin';
    if (!hasAdminRole) return false;
    const participantNumber = p.id.split('@')[0].split(':')[0];
    console.log(`[DEBUG] Checking admin participant: ${p.id} (${p.admin}) - number: ${participantNumber}`);
    if (p.id === botJid || (botLid && p.id === botLid) || botNumber === participantNumber || (botLidNumber && botLidNumber === participantNumber)) {
      console.log(`[DEBUG] ✅ Matched admin: ${p.id}`);
      return true;
    }
    console.log(`[DEBUG] ❌ No match for ${p.id}`);
    return false;
  });
  console.log(`[DEBUG] Final admin check result: ${isAdmin}`);
  return isAdmin;
}

// FIXED: Add the missing generatePairingCode function
async function generatePairingCode(userId, phoneNumber, bot, messageId = null) {
  const userStates = getUserStates();
  try {
    const sock = userStates[userId]?.whatsapp?.socket;
    
    if (!sock) {
      throw new Error('Socket WhatsApp tidak tersedia');
    }

    console.log(`[DEBUG][${userId}] Generating pairing code for ${phoneNumber}`);
    
    // Request pairing code dari WhatsApp
    const code = await sock.requestPairingCode(phoneNumber);
    
    if (!code) {
      throw new Error('Gagal generate pairing code');
    }

    console.log(`[DEBUG][${userId}] Generated pairing code: ${code}`);
    
    // Format pairing code jadi lebih readable (XXXX-XXXX)
    const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
    
    const message = `🔐 *Pairing Code WhatsApp*\n\n` +
                   `📱 Nomor: ${phoneNumber}\n` +
                   `🔑 Code: \`${formattedCode}\`\n\n` +
                   `📋 *Cara pairing:*\n` +
                   `1. Buka WhatsApp\n` +
                   `2. Menu > Perangkat Tertaut\n` +
                   `3. Tautkan dengan nomor telepon\n` +
                   `4. Masukkan code: ${formattedCode}\n\n` +
                   `⏰ Code valid selama 60 detik!`;
    
    if (messageId) {
      // Edit existing message
      await bot.editMessageText(message, {
        chat_id: userId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });
    } else {
      // Send new message
      await bot.sendMessage(userId, message, {
        parse_mode: 'Markdown'
      });
    }
    
    console.log(`[DEBUG][${userId}] Sent pairing code to user`);
    return code;
    
  } catch (err) {
    console.error(`[ERROR][${userId}] Error generating pairing code:`, err);
    
    const errorMsg = `❌ *Error Generate Pairing Code*\n\n` +
                    `Error: ${err.message}\n\n` +
                    `Pastikan:\n` +
                    `• Nomor WhatsApp valid\n` +
                    `• WhatsApp sudah terinstall\n` +
                    `• Koneksi internet stabil`;
    
    if (messageId) {
      await bot.editMessageText(errorMsg, {
        chat_id: userId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Coba Lagi', callback_data: 'login' }],
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        }
      });
    } else {
      await bot.sendMessage(userId, errorMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Coba Lagi', callback_data: 'login' }],
            [{ text: '🏠 Menu Utama', callback_data: 'main_menu' }]
          ]
        }
      });
    }
    
    throw err;
  }
}

// FIXED: Add missing logoutWhatsApp function
async function logoutWhatsApp(userId) {
  const userStates = getUserStates();
  try {
    console.log(`[DEBUG][${userId}] Logging out WhatsApp...`);
    
    // Close socket connection
    if (userStates[userId]?.whatsapp?.socket) {
      try {
        await userStates[userId].whatsapp.socket.logout();
        console.log(`[DEBUG][${userId}] Socket logout successful`);
      } catch (err) {
        console.log(`[DEBUG][${userId}] Socket logout error (expected): ${err.message}`);
      }
    }
    
    // Clear user state
    if (userStates[userId]?.whatsapp) {
      userStates[userId].whatsapp.isConnected = false;
      userStates[userId].whatsapp.socket = null;
      userStates[userId].whatsapp.lastConnect = null;
    }
    
    // Delete session files
    const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}`);
    if (fs.existsSync(sessionPath)) {
      try {
        // Delete all files in session directory
        const files = fs.readdirSync(sessionPath);
        for (const file of files) {
          const filePath = path.join(sessionPath, file);
          fs.unlinkSync(filePath);
        }
        
        // Remove directory
        fs.rmdirSync(sessionPath);
        console.log(`[DEBUG][${userId}] Session directory deleted`);
      } catch (err) {
        console.error(`[ERROR][${userId}] Error deleting session files:`, err);
      }
    }
    
    console.log(`[DEBUG][${userId}] WhatsApp logout completed`);
    return true;
    
  } catch (err) {
    console.error(`[ERROR][${userId}] Error during WhatsApp logout:`, err);
    return false;
  }
}

// FIXED: Add missing toggleAutoAccept function
async function toggleAutoAccept(userId, enabled) {
  const userStates = getUserStates();
  try {
    console.log(`[DEBUG][${userId}] Toggling auto accept: ${enabled}`);
    
    // Initialize if not exists
    if (!userStates[userId]) {
      userStates[userId] = {};
    }
    
    if (!userStates[userId].autoAccept) {
      userStates[userId].autoAccept = {};
    }
    
    // Update state
    userStates[userId].autoAccept.enabled = enabled;
    
    // Save to file
    await saveUserSettings(userId);
    
    console.log(`[DEBUG][${userId}] Auto accept ${enabled ? 'enabled' : 'disabled'}`);
    return { success: true };
    
  } catch (err) {
    console.error(`[ERROR][${userId}] Error toggling auto accept:`, err);
    return { success: false, error: err.message };
  }
}

// FIXED: Add missing getAutoAcceptStatus function
function getAutoAcceptStatus(userId) {
  const userStates = getUserStates();
  try {
    const enabled = userStates[userId]?.autoAccept?.enabled || false;
    console.log(`[DEBUG][${userId}] Auto accept status: ${enabled}`);
    return { enabled };
  } catch (err) {
    console.error(`[ERROR][${userId}] Error getting auto accept status:`, err);
    return { enabled: false };
  }
}

async function promoteParticipant(userId, groupId, participantNumber) {
  const userStates = getUserStates();
  try {
    const sock = userStates[userId]?.whatsapp?.socket;
    if (!sock || !userStates[userId]?.whatsapp?.isConnected) {
      throw new Error('WhatsApp tidak terhubung');
    }
    console.log(`[DEBUG][${userId}] Promoting ${participantNumber} to admin in group ${groupId}`);
    const groupMetadata = await sock.groupMetadata(groupId);
    const botJid = sock.user.id;
    const botLid = sock.user.lid;
    if (!isBotAdminInGroup(groupMetadata, botJid, botLid)) {
      throw new Error('Bot bukan admin di grup ini');
    }
    let targetParticipant = await findParticipantInGroupWithMapping(userId, groupId, participantNumber);
    if (!targetParticipant) {
      console.log(`[DEBUG][${userId}] Participant not found, waiting 5 seconds and retrying...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      const freshGroupMetadata = await sock.groupMetadata(groupId);
      targetParticipant = await findParticipantInGroupWithMapping(userId, groupId, participantNumber);
      if (!targetParticipant) {
        console.log(`[DEBUG][${userId}] DEBUGGING - All participants with numbers:`);
        freshGroupMetadata.participants.forEach(p => {
          const extractedNumber = jidMapper.extractNumberFromJID(p.id);
          console.log(`[DEBUG][${userId}]   - JID: ${p.id}, Extracted: ${extractedNumber}, Target: ${participantNumber}`);
        });
        throw new Error(`Participant ${participantNumber} tidak ditemukan di grup`);
      }
    }
    console.log(`[DEBUG][${userId}] Using participant JID: ${targetParticipant.id} for number ${participantNumber}`);
    const actualJid = targetParticipant.id;
    const promotePromise = sock.groupParticipantsUpdate(groupId, [actualJid], 'promote');
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Promote timeout')), 25000));
    const result = await Promise.race([promotePromise, timeoutPromise]);
    console.log(`[DEBUG][${userId}] Promote result:`, result);
    if (result && result.length > 0 && result[0].status === '200') {
      console.log(`[DEBUG][${userId}] Successfully promoted ${participantNumber} (JID: ${actualJid}) in group ${groupId}`);
      return true;
    } else {
      const errorCode = result && result.length > 0 ? result[0].status : 'unknown';
      throw new Error(`Gagal promote: ${errorCode}`);
    }
  } catch (err) {
    console.error(`[ERROR][${userId}] Error promoting participant ${participantNumber} in group ${groupId}:`, err);
    throw err;
  }
}

async function demoteParticipant(userId, groupId, participantNumber) {
  const userStates = getUserStates();
  try {
    const sock = userStates[userId]?.whatsapp?.socket;
    if (!sock || !userStates[userId]?.whatsapp?.isConnected) {
      throw new Error('WhatsApp tidak terhubung');
    }
    console.log(`[DEBUG][${userId}] Demoting ${participantNumber} from admin in group ${groupId}`);
    const groupMetadata = await sock.groupMetadata(groupId);
    const botJid = sock.user.id;
    const botLid = sock.user.lid;
    if (!isBotAdminInGroup(groupMetadata, botJid, botLid)) {
      throw new Error('Bot bukan admin di grup ini');
    }
    let targetParticipant = null;
    const possibleJids = [`${participantNumber}@s.whatsapp.net`, `${participantNumber}@lid`];
    for (const possibleJid of possibleJids) {
      targetParticipant = groupMetadata.participants.find(p => p.id === possibleJid && (p.admin === 'admin' || p.admin === 'superadmin'));
      if (targetParticipant) {
        console.log(`[DEBUG][${userId}] Found admin via direct JID match: ${targetParticipant.id}`);
        break;
      }
    }
    if (!targetParticipant) {
      console.log(`[DEBUG][${userId}] Direct JID match failed, trying JID mapping...`);
      const foundParticipant = await findParticipantInGroupWithMapping(userId, groupId, participantNumber);
      if (foundParticipant && (foundParticipant.admin === 'admin' || foundParticipant.admin === 'superadmin')) {
        targetParticipant = foundParticipant;
        console.log(`[DEBUG][${userId}] Found admin via JID mapping: ${targetParticipant.id} with role: ${targetParticipant.admin}`);
      }
    }
    if (!targetParticipant) {
      console.log(`[DEBUG][${userId}] JID mapping failed, trying LID mapping system...`);
      const adminParticipants = groupMetadata.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
      for (const adminP of adminParticipants) {
        const mappedPhone = globalLIDMapper.getPhoneFromLID(adminP.id, groupId);
        if (mappedPhone && mappedPhone === participantNumber) {
          targetParticipant = adminP;
          console.log(`[DEBUG][${userId}] Found admin via LID mapping: ${adminP.id} → ${mappedPhone}`);
          break;
        }
        const extractedPhone = extractCleanPhoneNumber(adminP.id, userStates, userId, groupId);
        if (extractedPhone === participantNumber) {
          targetParticipant = adminP;
          console.log(`[DEBUG][${userId}] Found admin via phone extraction: ${adminP.id} → ${extractedPhone}`);
          break;
        }
      }
    }
    if (!targetParticipant) {
      console.log(`[DEBUG][${userId}] DEBUGGING - All participants with phone mappings:`);
      groupMetadata.participants.forEach(p => {
        const mappedPhone = globalLIDMapper.getPhoneFromLID(p.id, groupId);
        const extractedPhone = extractCleanPhoneNumber(p.id, userStates, userId, groupId);
        console.log(`[DEBUG][${userId}]   - JID: ${p.id}, Admin: ${p.admin || 'member'}, Mapped: ${mappedPhone}, Extracted: ${extractedPhone}`);
      });
      throw new Error(`Admin dengan nomor ${participantNumber} tidak ditemukan di grup`);
    }
    console.log(`[DEBUG][${userId}] Found admin participant: ${targetParticipant.id} with role: ${targetParticipant.admin}`);
    const actualJid = targetParticipant.id;
    let demoteSuccess = false;
    let demoteAttempts = 0;
    const maxDemoteAttempts = 3;
    while (!demoteSuccess && demoteAttempts < maxDemoteAttempts) {
      demoteAttempts++;
      try {
        console.log(`[DEBUG][${userId}] Demote attempt ${demoteAttempts}/${maxDemoteAttempts} for ${actualJid}`);
        const demotePromise = sock.groupParticipantsUpdate(groupId, [actualJid], 'demote');
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Demote timeout')), 20000));
        const result = await Promise.race([demotePromise, timeoutPromise]);
        console.log(`[DEBUG][${userId}] Demote attempt ${demoteAttempts} result:`, result);
        if (result && result.length > 0 && result[0].status === '200') {
          demoteSuccess = true;
          console.log(`[DEBUG][${userId}] Successfully demoted ${participantNumber} (JID: ${actualJid}) in group ${groupId}`);
          setTimeout(async () => {
            try {
              const updatedMetadata = await sock.groupMetadata(groupId);
              const updatedParticipant = updatedMetadata.participants.find(p => p.id === actualJid);
              const adminStatus = updatedParticipant?.admin || 'member';
              console.log(`[DEBUG][${userId}] Verification: ${actualJid} admin status: ${adminStatus}`);
              if (adminStatus === 'member' || !adminStatus) {
                console.log(`[DEBUG][${userId}] ✅ Verified: Participant ${participantNumber} successfully demoted`);
              } else {
                console.log(`[DEBUG][${userId}] ⚠️ Warning: Participant ${participantNumber} still has admin role: ${adminStatus}`);
              }
            } catch (verifyErr) {
              console.log(`[DEBUG][${userId}] Could not verify demote result: ${verifyErr.message}`);
            }
          }, 2000);
          break;
        } else {
          const errorCode = result && result.length > 0 ? result[0].status : 'unknown';
          if (demoteAttempts < maxDemoteAttempts) {
            console.log(`[DEBUG][${userId}] Waiting 5 seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else {
            throw new Error(`Gagal demote: Status ${errorCode} - ${getDemoteErrorMessage(errorCode)}`);
          }
        }
      } catch (err) {
        console.log(`[DEBUG][${userId}] Demote attempt ${demoteAttempts} failed: ${err.message}`);
        if (demoteAttempts < maxDemoteAttempts) {
          console.log(`[DEBUG][${userId}] Waiting 5 seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          throw err;
        }
      }
    }
    return demoteSuccess;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error demoting participant ${participantNumber} in group ${groupId}:`, err);
    throw err;
  }
}

function getDemoteErrorMessage(statusCode) {
  const errorMessages = {
    '403': 'Tidak memiliki izin untuk demote admin ini',
    '404': 'Participant tidak ditemukan',
    '406': 'Tidak bisa demote superadmin atau owner grup',
    '409': 'Participant bukan admin',
    '500': 'Server error'
  };
  return errorMessages[statusCode] || 'Error tidak dikenal';
}

async function renameGroup(userId, groupId, newName) {
  const userStates = getUserStates();
  try {
    const sock = userStates[userId]?.whatsapp?.socket;
    if (!sock || !userStates[userId]?.whatsapp?.isConnected) {
      throw new Error('WhatsApp tidak terhubung');
    }
    console.log(`[DEBUG][${userId}] Renaming group ${groupId} to "${newName}"`);
    if (!sock.user || !sock.user.id) {
      throw new Error('Socket user tidak tersedia');
    }
    const groupMetadata = await sock.groupMetadata(groupId);
    if (!groupMetadata) {
      throw new Error('Grup tidak ditemukan');
    }
    console.log(`[DEBUG][${userId}] Group found: ${groupMetadata.subject}, participants: ${groupMetadata.participants.length}`);
    const botJid = sock.user.id;
    const botLid = sock.user.lid;
    if (!isBotAdminInGroup(groupMetadata, botJid, botLid)) {
      throw new Error('Bot bukan admin di grup ini');
    }
    console.log(`[DEBUG][${userId}] Bot is admin, proceeding with rename...`);
    let renameSuccess = false;
    let lastError = null;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[DEBUG][${userId}] Rename attempt ${attempt}/${maxAttempts}`);
        const renamePromise = sock.groupUpdateSubject(groupId, newName);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Rename timeout')), 20000));
        await Promise.race([renamePromise, timeoutPromise]);
        console.log(`[DEBUG][${userId}] Successfully renamed group ${groupId} to "${newName}"`);
        renameSuccess = true;
        break;
      } catch (err) {
        console.log(`[DEBUG][${userId}] Rename attempt ${attempt} failed: ${err.message}`);
        lastError = err;
        if (attempt < maxAttempts) {
          console.log(`[DEBUG][${userId}] Waiting 5 seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
    if (!renameSuccess) {
      throw lastError || new Error('All rename attempts failed');
    }
    return true;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error renaming group ${groupId}:`, err);
    throw err;
  }
}

async function checkPendingRequests(userId, sock) {
  const userStates = getUserStates();
  if (!userStates[userId]?.autoAccept?.enabled) {
    console.log(`[DEBUG][${userId}] Auto accept disabled, skipping pending requests check`);
    return;
  }
  try {
    console.log(`[DEBUG][${userId}] Checking for pending join requests...`);
    const groups = await sock.groupFetchAllParticipating();
    for (const groupId in groups) {
      const group = groups[groupId];
      const botJid = sock.user.id;
      const botLid = sock.user.lid;
      const isAdmin = isBotAdminInGroup(group, botJid, botLid);
      console.log(`[DEBUG][${userId}] Is admin in group ${groupId}: ${isAdmin}`);
      if (!isAdmin) {
        console.log(`[DEBUG][${userId}] Not admin in group ${groupId}, skipping`);
        continue;
      }
      console.log(`[DEBUG][${userId}] Checking group ${groupId} for pending requests...`);
      let pendingRequests = [];
      try {
        const requests1 = await sock.groupRequestParticipantsList(groupId);
        if (requests1 && requests1.length > 0) {
          pendingRequests = requests1;
          console.log(`[DEBUG][${userId}] Method 1: Found ${requests1.length} pending requests`);
        }
      } catch (err) {
        console.log(`[DEBUG][${userId}] Method 1 failed: ${err.message}`);
      }
      if (pendingRequests.length === 0) {
        try {
          const groupInfo = await sock.groupMetadata(groupId);
          if (groupInfo.pendingParticipants && groupInfo.pendingParticipants.length > 0) {
            pendingRequests = groupInfo.pendingParticipants;
            console.log(`[DEBUG][${userId}] Method 2: Found ${pendingRequests.length} pending requests in metadata`);
          }
        } catch (err) {
          console.log(`[DEBUG][${userId}] Method 2 failed: ${err.message}`);
        }
      }
      if (pendingRequests && pendingRequests.length > 0) {
        console.log(`[DEBUG][${userId}] Processing ${pendingRequests.length} pending requests in group ${groupId}`);
        for (const request of pendingRequests) {
          try {
            const participantJid = request.jid || request.id || request;
            console.log(`[DEBUG][${userId}] Attempting to approve: ${participantJid}`);
            await sock.groupRequestParticipantsUpdate(groupId, [participantJid], 'approve');
            console.log(`[DEBUG][${userId}] ✅ Auto approved pending request from ${participantJid} in group ${groupId}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (err) {
            console.error(`[ERROR][${userId}] Failed to approve ${request.jid || request.id || request}:`, err.message);
          }
        }
      } else {
        console.log(`[DEBUG][${userId}] No pending requests found for group ${groupId}`);
      }
    }
  } catch (err) {
    console.error(`[ERROR][${userId}] Error checking pending requests:`, err.message);
  }
}

async function restoreAllSessions(bot) {
  const sessionsPath = config.whatsapp.sessionPath;
  const restoredSessions = [];
  if (!fs.existsSync(sessionsPath)) {
    console.log('No sessions directory found');
    return restoredSessions;
  }
  try {
    const sessionDirs = fs.readdirSync(sessionsPath)
      .filter(dir => dir.startsWith('wa_') && fs.statSync(path.join(sessionsPath, dir)).isDirectory());
    console.log(`Found ${sessionDirs.length} potential sessions:`, sessionDirs);
    for (const sessionDir of sessionDirs) {
      try {
        const userId = sessionDir.replace('wa_', '');
        const sessionPath = path.join(sessionsPath, sessionDir);
        const credsFile = path.join(sessionPath, 'creds.json');
        if (!fs.existsSync(credsFile)) {
          console.log(`Skipping ${sessionDir} - no creds.json found`);
          continue;
        }
        console.log(`Restoring session for userId: ${userId}`);
        const sock = await createWhatsAppConnection(userId, bot, false, true);
        if (sock) {
          restoredSessions.push(userId);
          console.log(`✅ Session restored for userId: ${userId}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          console.log(`❌ Failed to restore session for userId: ${userId}`);
        }
      } catch (err) {
        console.error(`Error restoring session ${sessionDir}:`, err.message);
      }
    }
    return restoredSessions;
  } catch (err) {
    console.error('Error scanning sessions directory:', err);
    return restoredSessions;
  }
}

async function createWhatsAppConnection(userId, bot, reconnect = false, isRestore = false) {
  try {
    const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}`);
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const isExistingSession = fs.existsSync(path.join(sessionPath, 'creds.json'));
    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Safari"),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 5000
    });
    const userStates = getUserStates();
    if (!userStates[userId]) {
      userStates[userId] = {};
    }
    userStates[userId].whatsapp = {
      socket: sock,
      isConnected: false,
      lastConnect: null,
      isWaitingForPairingCode: false,
      isWaitingForQR: false,
      lastQRTime: null,
      isExistingSession: isExistingSession
    };
    const settingsPath = path.join(sessionPath, 'settings.json');
    let autoAcceptEnabled = false;
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        autoAcceptEnabled = settings.autoAccept || false;
      } catch (err) {
        console.warn(`Error loading settings for ${userId}:`, err.message);
      }
    }
    userStates[userId].autoAccept = { enabled: autoAcceptEnabled };
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log(`[DEBUG] Connection update for ${userId}: ${connection}`);
      if (qr && !isExistingSession && userStates[userId]?.whatsapp?.isWaitingForQR) {
        const now = Date.now();
        const lastQRTime = userStates[userId].whatsapp.lastQRTime || 0;
        if (now - lastQRTime < 30000) {
          console.log(`[DEBUG] Skipping QR code for ${userId} - too soon since last QR`);
          return;
        }
        try {
          userStates[userId].whatsapp.lastQRTime = now;
          const qrUrl = await require('qrcode').toDataURL(qr);
          const qrBuffer = Buffer.from(qrUrl.split(',')[1], 'base64');
          await bot.sendPhoto(userId, qrBuffer, {
            caption: "🔒 *Scan QR Code ini dengan WhatsApp*\n\nBuka WhatsApp > Menu > Perangkat Tertaut > Tautkan Perangkat\n\nQR code valid selama 60 detik!",
            parse_mode: 'Markdown'
          });
          console.log(`[DEBUG] Sent QR code to user ${userId}`);
        } catch (qrErr) {
          console.error(`[ERROR] Failed to send QR code: ${qrErr.message}`);
          await bot.sendMessage(userId, "❌ Error saat mengirim QR code. Coba lagi nanti.");
        }
      }
      if (connection === "open") {
        console.log(`WhatsApp connection open for user: ${userId}`);
        reconnectAttempts[userId] = 0;
        setupAutoAcceptHandler(userId);
        if (userStates[userId] && userStates[userId].whatsapp) {
          userStates[userId].whatsapp.isConnected = true;
          userStates[userId].whatsapp.lastConnect = new Date();
          userStates[userId].whatsapp.isWaitingForPairingCode = false;
          userStates[userId].whatsapp.isWaitingForQR = false;
          userStates[userId].whatsapp.lastQRTime = null;
          await saveUserSettings(userId);
        }
        setTimeout(async () => {
          await checkPendingRequests(userId, sock);
        }, 5000);
        if (isRestore) {
          console.log(`Session restored for userId: ${userId}`);
        } else if (reconnect) {
          await bot.sendMessage(userId, "✅ *Reconnect berhasil!* Bot WhatsApp sudah terhubung kembali.", { parse_mode: 'Markdown' });
        } else if (!isRestore) {
          await bot.sendMessage(userId, "🚀 *Bot WhatsApp berhasil terhubung!*\n\nSekarang kamu bisa menggunakan auto accept!", { parse_mode: 'Markdown' });
        }
      } else if (connection === "close") {
        if (userStates[userId] && userStates[userId].whatsapp) {
          userStates[userId].whatsapp.isConnected = false;
        }
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const disconnectReason = lastDisconnect?.error?.output?.payload?.message || "Unknown";
        console.log(`[DEBUG] Connection closed for userId ${userId}. Status code: ${statusCode}, Reason: ${disconnectReason}`);
        let shouldReconnect = statusCode !== 401 && statusCode !== 403;
        if (!reconnectAttempts[userId]) {
          reconnectAttempts[userId] = 0;
        }
        if (shouldReconnect && userStates[userId] && reconnectAttempts[userId] < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts[userId]++;
          if (reconnectAttempts[userId] === 1 && !isRestore) {
            await bot.sendMessage(userId, `⚠️ *Koneksi terputus*\nReason: ${disconnectReason}\n\nSedang mencoba reconnect... (Attempt ${reconnectAttempts[userId]}/${MAX_RECONNECT_ATTEMPTS})`, { parse_mode: 'Markdown' });
          }
          setTimeout(async () => {
            if (userStates[userId]) {
              console.log(`Attempting reconnect ${reconnectAttempts[userId]} for userId: ${userId}`);
              await createWhatsAppConnection(userId, bot, true);
            }
          }, 5000);
        } else if (!shouldReconnect) {
          console.log(`[DEBUG] Not reconnecting for userId ${userId}. Status code: ${statusCode}`);
          await bot.sendMessage(userId, `❌ *Koneksi ditutup*\nReason: ${disconnectReason}\n\nSilakan hubungkan ulang secara manual.`, { parse_mode: 'Markdown' });
        }
      }
    });
    return sock;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error creating WhatsApp connection:`, err);
    return null;
  }
}

async function saveUserSettings(userId) {
  const userStates = getUserStates();
  try {
    const sessionPath = path.join(config.whatsapp.sessionPath, `wa_${userId}`);
    const settingsPath = path.join(sessionPath, 'settings.json');
    const settings = {
      autoAccept: userStates[userId]?.autoAccept?.enabled || false
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`[DEBUG][${userId}] Saved user settings`);
  } catch (err) {
    console.error(`[ERROR][${userId}] Error saving user settings:`, err);
  }
}

function setupAutoAcceptHandler(userId) {
  console.log(`[DEBUG][${userId}] Setting up auto accept handler`);
  // Implementation depends on bot framework (e.g., Telegraf for Telegram)
}

async function sendBlastMessage(userId, phoneNumber, message) {
  const userStates = getUserStates();
  try {
    const sock = userStates[userId]?.whatsapp?.socket;
    if (!sock || !userStates[userId]?.whatsapp?.isConnected) {
      throw new Error('WhatsApp tidak terhubung');
    }
    console.log(`[DEBUG][${userId}] Sending blast message to ${phoneNumber}`);
    const recipientJid = `${phoneNumber}@s.whatsapp.net`;
    const sendPromise = sock.sendMessage(recipientJid, { text: message });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Send message timeout')), 15000));
    const result = await Promise.race([sendPromise, timeoutPromise]);
    console.log(`[DEBUG][${userId}] Successfully sent blast message to ${phoneNumber}`);
    return result;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error sending blast message to ${phoneNumber}:`, err);
    throw err;
  }
}

async function getAllGroups(userId) {
  const userStates = getUserStates();
  try {
    const sock = userStates[userId]?.whatsapp?.socket;
    if (!sock || !userStates[userId]?.whatsapp?.isConnected) {
      throw new Error('WhatsApp tidak terhubung');
    }
    console.log(`[DEBUG][${userId}] Getting all groups...`);
    const groups = await sock.groupFetchAllParticipating();
    const groupList = [];
    for (const groupId in groups) {
      const group = groups[groupId];
      if (group.participants && group.participants.length > 0) {
        const botJid = sock.user.id;
        const botLid = sock.user.lid;
        groupList.push({
          id: groupId,
          name: group.subject || 'Unnamed Group',
          participantCount: group.participants.length,
          isAdmin: isBotAdminInGroup(group, botJid, botLid)
        });
      }
    }
    console.log(`[DEBUG][${userId}] Found ${groupList.length} groups`);
    groupList.sort((a, b) => a.name.localeCompare(b.name));
    return groupList;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error getting groups:`, err);
    throw err;
  }
}

async function getGroupAdmins(userId, groupId) {
  const userStates = getUserStates();
  try {
    const sock = userStates[userId]?.whatsapp?.socket;
    if (!sock || !userStates[userId]?.whatsapp?.isConnected) {
      throw new Error('WhatsApp tidak terhubung');
    }
    console.log(`[DEBUG][${userId}] Getting admins for group ${groupId}`);
    await discoverLIDMappings(userStates, userId, groupId);
    const groupMetadata = await sock.groupMetadata(groupId);
    if (!groupMetadata || !groupMetadata.participants) {
      throw new Error('Gagal mendapatkan data grup');
    }
    const admins = groupMetadata.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
    console.log(`[DEBUG][${userId}] Found ${admins.length} admins in group ${groupId}`);
    return admins;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error getting group admins:`, err);
    throw err;
  }
}

async function isParticipantInGroup(userId, groupId, participantNumber) {
  try {
    return await isParticipantInGroupWithMapping(userId, groupId, participantNumber);
  } catch (err) {
    console.error(`[ERROR][${userId}] Error checking participant in group:`, err);
    return false;
  }
}

async function findParticipantJidInGroup(userId, groupId, participantNumber) {
  const userStates = getUserStates();
  try {
    const sock = userStates[userId]?.whatsapp?.socket;
    if (!sock || !userStates[userId]?.whatsapp?.isConnected) {
      throw new Error('WhatsApp tidak terhubung');
    }
    console.log(`[DEBUG][${userId}] Finding JID for ${participantNumber} in group ${groupId}`);
    const groupMetadata = await sock.groupMetadata(groupId);
    if (!groupMetadata || !groupMetadata.participants) {
      return null;
    }
    const participant = groupMetadata.participants.find(p => {
      if (p.id === `${participantNumber}@s.whatsapp.net` || p.id === `${participantNumber}@s.whatsapp.net`) {
        return true;
      }
      const participantNumberFromJid = p.id.split('@')[0].split(':')[0];
      if (participantNumberFromJid === participantNumber) {
        return true;
      }
      const mappedPhone = globalLIDMapper.getPhoneFromLID(p.id, groupId);
      if (mappedPhone === participantNumber) {
        return true;
      }
      if (participantNumber.includes(participantNumberFromJid) || participantNumberFromJid.includes(participantNumber)) {
        return true;
      }
      const last8Original = participantNumber.slice(-8);
      const last8JID = participantNumberFromJid.slice(-8);
      if (last8Original === last8JID && last8Original.length === 8) {
        return true;
      }
      return false;
    });
    if (participant) {
      console.log(`[DEBUG][${userId}] Found participant JID: ${participant.id} for number ${participantNumber}`);
      return participant.id;
    }
    console.log(`[DEBUG][${userId}] No JID found for number ${participantNumber}`);
    return null;
  } catch (err) {
    console.error(`[ERROR][${userId}] Error finding participant JID:`, err);
    return null;
  }
}

async function addParticipantToGroup(userId, groupId, participantNumber) {
  const userStates = getUserStates();
  try {
    const sock = userStates[userId]?.whatsapp?.socket;
    if (!sock || !userStates[userId]?.whatsapp?.isConnected) {
      throw new Error('WhatsApp tidak terhubung');
    }
    console.log(`[DEBUG][${userId}] Adding ${participantNumber} to group ${groupId}`);
    const groupMetadataBefore = await sock.groupMetadata(groupId);
    const participantsBefore = groupMetadataBefore.participants.map(p => p.id);
    console.log(`[DEBUG][${userId}] Participants BEFORE add:`, participantsBefore);
    const botJid = sock.user.id;
    const botLid = sock.user.lid;
    const isAdmin = isBotAdminInGroup(groupMetadataBefore, botJid, botLid);
    if (!isAdmin && groupMetadataBefore.memberAddMode !== true) {
      throw new Error('Bot bukan admin dan grup tidak mengizinkan member menambah participant');
    }
    let targetJID;
    try {
      targetJID = await resolveActualJID(userId, participantNumber, sock);
      console.log(`[DEBUG][${userId}] Resolved JID: ${participantNumber} → ${targetJID}`);
    } catch (err) {
      console.log(`[DEBUG][${userId}] JID resolution failed, using standard format`);
      targetJID = `${participantNumber}@s.whatsapp.net`;
    }
    const participantJids = [...new Set([targetJID, `${participantNumber}@s.whatsapp.net`])];
    let addResult = null;
    let lastError = null;
    let actualAddedJid = null;
    for (const participantJid of participantJids) {
      try {
        console.log(`[DEBUG][${userId}] Trying to add with JID: ${participantJid}`);
        const addPromise = sock.groupParticipantsUpdate(groupId, [participantJid], 'add');
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Add participant timeout')), 20000));
        addResult = await Promise.race([addPromise, timeoutPromise]);
        console.log(`[DEBUG][${userId}] Add participant result:`, addResult);
        if (addResult && addResult.length > 0) {
          const participantResult = addResult[0];
          console.log(`[DEBUG][${userId}] Result status: ${participantResult.status}, JID: ${participantResult.jid}`);
          if (participantResult.status === '200') {
            actualAddedJid = participantResult.jid;
            console.log(`[DEBUG][${userId}] Successfully added ${participantNumber} as ${actualAddedJid}`);
            jidMapper.addMapping(participantNumber, actualAddedJid);
            break;
          } else if (participantResult.status === '409') {
            actualAddedJid = participantResult.jid;
            console.log(`[DEBUG][${userId}] Participant already exists as ${actualAddedJid}`);
            jidMapper.addMapping(participantNumber, actualAddedJid);
            break;
          } else {
            lastError = new Error(`Status ${participantResult.status}: ${getAddParticipantErrorMessage(participantResult.status)}`);
          }
        }
      } catch (err) {
        console.log(`[DEBUG][${userId}] Failed with JID ${participantJid}: ${err.message}`);
        lastError = err;
        continue;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
    const groupMetadataAfter = await sock.groupMetadata(groupId);
    const participantsAfter = groupMetadataAfter.participants.map(p => p.id);
    console.log(`[DEBUG][${userId}] Participants AFTER add:`, participantsAfter);
    const newParticipants = participantsAfter.filter(p => !participantsBefore.includes(p));
    console.log(`[DEBUG][${userId}] New participants detected:`, newParticipants);
    if (newParticipants.length > 0) {
      for (const newJid of newParticipants) {
        if (jidMapper.isMatch(participantNumber, newJid)) {
          console.log(`[DEBUG][${userId}] ✅ Confirmed: ${participantNumber} was added as ${newJid}`);
          jidMapper.addMapping(participantNumber, newJid);
          return true;
        }
      }
      console.log(`[DEBUG][${userId}] ⚠️ Someone was added, assuming success`);
      return true;
    }
    const existingParticipant = await findParticipantInGroupWithMapping(userId, groupId, participantNumber);
    if (existingParticipant) {
      console.log(`[DEBUG][${userId}] ✅ Participant ${participantNumber} found in group as ${existingParticipant.id}`);
      return true;
    }
    if (lastError) {
      throw lastError;
    } else {
      throw new Error(`Gagal menambah participant ${participantNumber}. Nomor mungkin tidak valid atau diblokir.`);
    }
  } catch (err) {
    console.error(`[ERROR][${userId}] Error adding participant ${participantNumber} to group ${groupId}:`, err);
    throw err;
  }
}

function getAddParticipantErrorMessage(statusCode) {
  const errorMessages = {
    '403': 'Nomor tidak bisa ditambahkan ke grup (mungkin privasi atau blokir)',
    '408': 'Timeout - nomor tidak merespons',
    '409': 'Participant sudah ada di grup',
    '400': 'Request tidak valid',
    '401': 'Bot tidak memiliki izin',
    '404': 'Nomor tidak ditemukan'
  };
  return errorMessages[statusCode] || 'Error tidak dikenal';
}

module.exports = {
  generatePairingCode,
  logoutWhatsApp,
  toggleAutoAccept,
  getAutoAcceptStatus,
  promoteParticipant,
  demoteParticipant,
  renameGroup,
  checkPendingRequests,
  restoreAllSessions,
  createWhatsAppConnection,
  sendBlastMessage,
  getAllGroups,
  getGroupAdmins,
  isParticipantInGroup,
  findParticipantJidInGroup,
  addParticipantToGroup,
  extractCleanPhoneNumber,
  discoverLIDMappings,
  globalLIDMapper
};