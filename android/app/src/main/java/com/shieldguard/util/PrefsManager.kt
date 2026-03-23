package com.shieldguard.util

import android.content.Context
import android.content.SharedPreferences

/**
 * PrefsManager — encrypted SharedPreferences wrapper
 * All sensitive values should be stored via EncryptedSharedPreferences
 * (androidx.security:security-crypto) in production.
 */
class PrefsManager(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("shieldguard_prefs", Context.MODE_PRIVATE)

    // ── Device identity ───────────────────────────────────────────────────────
    var deviceId: String
        get() = prefs.getString("device_id", "") ?: ""
        set(v) = prefs.edit().putString("device_id", v).apply()

    var ownerEmail: String
        get() = prefs.getString("owner_email", "") ?: ""
        set(v) = prefs.edit().putString("owner_email", v).apply()

    // ── Server ────────────────────────────────────────────────────────────────
    var serverUrl: String
        get() = prefs.getString("server_url", "ws://localhost:3001/ws") ?: ""
        set(v) = prefs.edit().putString("server_url", v).apply()

    // ── FCM ───────────────────────────────────────────────────────────────────
    var fcmToken: String
        get() = prefs.getString("fcm_token", "") ?: ""
        set(v) = prefs.edit().putString("fcm_token", v).apply()

    // ── SIM monitoring ────────────────────────────────────────────────────────
    var simIccid: String
        get() = prefs.getString("sim_iccid", "") ?: ""
        set(v) = prefs.edit().putString("sim_iccid", v).apply()

    var simChangeLockEnabled: Boolean
        get() = prefs.getBoolean("sim_lock", true)
        set(v) = prefs.edit().putBoolean("sim_lock", v).apply()

    var simChangeAlarmEnabled: Boolean
        get() = prefs.getBoolean("sim_alarm", true)
        set(v) = prefs.edit().putBoolean("sim_alarm", v).apply()

    // ── Location ──────────────────────────────────────────────────────────────
    var locationIntervalSeconds: Long
        get() = prefs.getLong("loc_interval_s", 30L)
        set(v) = prefs.edit().putLong("loc_interval_s", v).apply()

    // ── Geofence ──────────────────────────────────────────────────────────────
    var geofenceEnabled: Boolean
        get() = prefs.getBoolean("geofence_enabled", false)
        set(v) = prefs.edit().putBoolean("geofence_enabled", v).apply()

    var geofenceLat: Double
        get() = java.lang.Double.longBitsToDouble(prefs.getLong("geofence_lat", 0))
        set(v) = prefs.edit().putLong("geofence_lat", java.lang.Double.doubleToLongBits(v)).apply()

    var geofenceLng: Double
        get() = java.lang.Double.longBitsToDouble(prefs.getLong("geofence_lng", 0))
        set(v) = prefs.edit().putLong("geofence_lng", java.lang.Double.doubleToLongBits(v)).apply()

    var geofenceRadiusMeters: Float
        get() = prefs.getFloat("geofence_radius", 500f)
        set(v) = prefs.edit().putFloat("geofence_radius", v).apply()

    var geofenceAlertSent: Boolean
        get() = prefs.getBoolean("geofence_alert_sent", false)
        set(v) = prefs.edit().putBoolean("geofence_alert_sent", v).apply()

    // ── Scheduled photos ──────────────────────────────────────────────────────
    var scheduledPhotoEnabled: Boolean
        get() = prefs.getBoolean("sched_photo", true)
        set(v) = prefs.edit().putBoolean("sched_photo", v).apply()

    var scheduledPhotoIntervalMin: Long
        get() = prefs.getLong("sched_photo_min", 60L)
        set(v) = prefs.edit().putLong("sched_photo_min", v).apply()

    // ── Stealth ───────────────────────────────────────────────────────────────
    var stealthMode: Boolean
        get() = prefs.getBoolean("stealth", true)
        set(v) = prefs.edit().putBoolean("stealth", v).apply()
}

// ─────────────────────────────────────────────────────────────────────────────

package com.shieldguard.model

/**
 * LocationUpdate — serialized to Firestore
 */
data class LocationUpdate(
    val deviceId:  String,
    val latitude:  Double,
    val longitude: Double,
    val altitude:  Double,
    val speed:     Float,
    val accuracy:  Float,
    val timestamp: Long
) {
    fun toMap() = mapOf(
        "deviceId"  to deviceId,
        "lat"       to latitude,
        "lng"       to longitude,
        "altitude"  to altitude,
        "speed"     to speed,
        "accuracy"  to accuracy,
        "timestamp" to timestamp
    )
}

/**
 * DeviceEvent — audit trail entry
 */
data class DeviceEvent(
    val deviceId:  String,
    val type:      String,
    val detail:    String,
    val timestamp: Long
) {
    fun toMap() = mapOf(
        "deviceId"  to deviceId,
        "type"      to type,
        "detail"    to detail,
        "timestamp" to timestamp
    )
}
