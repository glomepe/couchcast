// couchcast-bridge : pont entre une PS5 (protocole Remote Play, via la lib de chiaki-ng)
// et le serveur Couchcast.
//
//   couchcast-bridge discover [--host IP] [--timeout S]       → JSON (une ligne par console)
//   couchcast-bridge wakeup   --host IP --regist-key KEY      → réveille la console en veille
//   couchcast-bridge regist   --host IP --account-id B64 --pin PIN → JSON {regist_key, morning, ...}
//   couchcast-bridge stream   --host IP --regist-key KEY --morning B64 --account-id B64
//                        [--resolution 360|540|720|1080] [--fps 30|60] [--bitrate KBPS] [--spectator]
//
// En mode stream, stdout transporte des paquets binaires (voir PROTOCOL ci-dessous),
// stdin reçoit des commandes, et stderr les logs texte.
//
// PROTOCOL (little-endian) — paquet = u8 type | u32 longueur | u64 horodatage µs | données
//   1 VIDEO   unité d'accès H.264 Annex-B
//   2 AUDIO   paquet Opus
//   3 EVENT   objet JSON (connected, audio_header, quit, frames_lost, ...)
// Commandes stdin — u8 type | u32 longueur | données
//   1 CONTROLLER  u32 boutons | u8 l2 | u8 r2 | i16 lx | i16 ly | i16 rx | i16 ry  (14 octets)
//   2 IDR         demande une image clé
//   3 STOP        termine la session proprement
//   4 PIN         code PIN de connexion (ASCII)

#include <chiaki/base64.h>
#include <chiaki/common.h>
#include <chiaki/controller.h>
#include <chiaki/discovery.h>
#include <chiaki/log.h>
#include <chiaki/regist.h>
#include <chiaki/session.h>

#include <arpa/inet.h>
#include <getopt.h>
#include <netdb.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

enum { PKT_VIDEO = 1, PKT_AUDIO = 2, PKT_EVENT = 3 };
enum { CMD_CONTROLLER = 1, CMD_IDR = 2, CMD_STOP = 3, CMD_PIN = 4 };

typedef struct {
	const char *host;
	const char *regist_key;
	const char *morning;
	const char *account_id;
	const char *pin;
	int resolution;
	int fps;
	int bitrate;
	double timeout;
	bool verbose;
	bool spectator;
} Options;

static ChiakiLog g_log;
static pthread_mutex_t g_out_lock = PTHREAD_MUTEX_INITIALIZER;

static void die(const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	fputs("couchcast-bridge: ", stderr);
	vfprintf(stderr, fmt, ap);
	fputc('\n', stderr);
	va_end(ap);
	exit(2);
}

static uint64_t now_us(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static void log_cb(ChiakiLogLevel level, const char *msg, void *user)
{
	(void)user;
	const char *tag = level == CHIAKI_LOG_ERROR ? "E" : level == CHIAKI_LOG_WARNING ? "W" : level == CHIAKI_LOG_INFO ? "I" : "D";
	fprintf(stderr, "[chiaki %s] %s\n", tag, msg);
}

// Écrit tout le buffer sur un descripteur (gère les écritures partielles).
static bool write_all(int fd, const void *buf, size_t size)
{
	const uint8_t *p = buf;
	while(size > 0)
	{
		ssize_t n = write(fd, p, size);
		if(n <= 0)
			return false;
		p += n;
		size -= (size_t)n;
	}
	return true;
}

static void emit(uint8_t type, const void *data, size_t size)
{
	uint8_t header[13];
	uint32_t len = (uint32_t)size;
	uint64_t ts = now_us();
	header[0] = type;
	memcpy(header + 1, &len, 4); // les cibles (arm64/x86_64) sont little-endian
	memcpy(header + 5, &ts, 8);

	pthread_mutex_lock(&g_out_lock);
	bool ok = write_all(STDOUT_FILENO, header, sizeof(header)) && write_all(STDOUT_FILENO, data, size);
	pthread_mutex_unlock(&g_out_lock);
	if(!ok)
		_exit(0); // le serveur a fermé le tube : plus personne pour lire
}

static void emit_event(const char *fmt, ...)
{
	char buf[1024];
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);
	if(n > 0)
		emit(PKT_EVENT, buf, (size_t)(n < (int)sizeof(buf) ? n : (int)sizeof(buf) - 1));
}

// Échappe une chaîne pour l'insérer dans du JSON (sortie tronquée si trop longue).
static const char *json_str(const char *in, char *out, size_t out_size)
{
	size_t o = 0;
	for(const char *p = in ? in : ""; *p && o + 7 < out_size; p++)
	{
		unsigned char c = (unsigned char)*p;
		if(c == '"' || c == '\\')
		{
			out[o++] = '\\';
			out[o++] = (char)c;
		}
		else if(c < 0x20)
			o += (size_t)snprintf(out + o, out_size - o, "\\u%04x", c);
		else
			out[o++] = (char)c;
	}
	out[o] = '\0';
	return out;
}

static void decode_account_id(const char *b64, uint8_t out[CHIAKI_PSN_ACCOUNT_ID_SIZE])
{
	uint8_t buf[64];
	size_t size = sizeof(buf);
	if(!b64 || chiaki_base64_decode(b64, strlen(b64), buf, &size) != CHIAKI_ERR_SUCCESS || size != CHIAKI_PSN_ACCOUNT_ID_SIZE)
		die("--account-id invalide (attendu : 8 octets encodés en base64)");
	memcpy(out, buf, CHIAKI_PSN_ACCOUNT_ID_SIZE);
}

// --- discover --------------------------------------------------------------

typedef struct {
	char seen[16][64];
	int count;
	pthread_mutex_t lock;
} DiscoverState;

static void discover_cb(ChiakiDiscoveryHost *host, void *user)
{
	DiscoverState *st = user;
	pthread_mutex_lock(&st->lock);
	const char *id = host->host_id ? host->host_id : (host->host_addr ? host->host_addr : "");
	for(int i = 0; i < st->count; i++)
	{
		if(strcmp(st->seen[i], id) == 0)
		{
			pthread_mutex_unlock(&st->lock);
			return;
		}
	}
	if(st->count < 16)
		snprintf(st->seen[st->count++], sizeof(st->seen[0]), "%s", id);

	char a[128], b[128], c[128], d[128], e[128];
	printf("{\"host\":\"%s\",\"name\":\"%s\",\"type\":\"%s\",\"id\":\"%s\",\"ps5\":%s,\"state\":\"%s\",\"running_app\":\"%s\"}\n",
		json_str(host->host_addr, a, sizeof(a)),
		json_str(host->host_name, b, sizeof(b)),
		json_str(host->host_type, c, sizeof(c)),
		json_str(host->host_id, d, sizeof(d)),
		chiaki_discovery_host_is_ps5(host) ? "true" : "false",
		host->state == CHIAKI_DISCOVERY_HOST_STATE_READY ? "ready" : host->state == CHIAKI_DISCOVERY_HOST_STATE_STANDBY ? "standby" : "unknown",
		json_str(host->running_app_name, e, sizeof(e)));
	fflush(stdout);
	pthread_mutex_unlock(&st->lock);
}

static int cmd_discover(const Options *o)
{
	const char *target = o->host ? o->host : "255.255.255.255";
	struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_DGRAM };
	struct addrinfo *ai = NULL;
	if(getaddrinfo(target, NULL, &hints, &ai) != 0 || !ai)
		die("adresse invalide : %s", target);
	struct sockaddr_in addr;
	memcpy(&addr, ai->ai_addr, sizeof(addr));
	freeaddrinfo(ai);

	ChiakiDiscovery discovery;
	if(chiaki_discovery_init(&discovery, &g_log, AF_INET) != CHIAKI_ERR_SUCCESS)
		die("initialisation de la découverte impossible");

	DiscoverState st = { .count = 0 };
	pthread_mutex_init(&st.lock, NULL);
	ChiakiDiscoveryThread thread;
	if(chiaki_discovery_thread_start(&thread, &discovery, discover_cb, &st) != CHIAKI_ERR_SUCCESS)
		die("thread de découverte impossible");

	ChiakiDiscoveryPacket packet = { .cmd = CHIAKI_DISCOVERY_CMD_SRCH };
	uint64_t end = now_us() + (uint64_t)(o->timeout * 1e6);
	while(now_us() < end)
	{
		packet.protocol_version = CHIAKI_DISCOVERY_PROTOCOL_VERSION_PS5;
		addr.sin_port = htons(CHIAKI_DISCOVERY_PORT_PS5);
		chiaki_discovery_send(&discovery, &packet, (struct sockaddr *)&addr, sizeof(addr));
		packet.protocol_version = CHIAKI_DISCOVERY_PROTOCOL_VERSION_PS4;
		addr.sin_port = htons(CHIAKI_DISCOVERY_PORT_PS4);
		chiaki_discovery_send(&discovery, &packet, (struct sockaddr *)&addr, sizeof(addr));
		usleep(500000);
	}

	chiaki_discovery_thread_stop(&thread);
	chiaki_discovery_fini(&discovery);
	return st.count > 0 ? 0 : 1;
}

// --- wakeup ----------------------------------------------------------------

static int cmd_wakeup(const Options *o)
{
	if(!o->host || !o->regist_key)
		die("wakeup : --host et --regist-key sont requis");
	uint64_t credential = strtoull(o->regist_key, NULL, 16);
	ChiakiErrorCode err = chiaki_discovery_wakeup(&g_log, NULL, o->host, credential, true);
	if(err != CHIAKI_ERR_SUCCESS)
		die("réveil échoué : %s", chiaki_error_string(err));
	return 0;
}

// --- regist ----------------------------------------------------------------

typedef struct {
	pthread_mutex_t lock;
	pthread_cond_t cond;
	bool done;
	bool ok;
	ChiakiRegisteredHost host;
} RegistState;

static void regist_cb(ChiakiRegistEvent *event, void *user)
{
	RegistState *st = user;
	pthread_mutex_lock(&st->lock);
	st->ok = event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS;
	if(st->ok)
		st->host = *event->registered_host;
	st->done = true;
	pthread_cond_signal(&st->cond);
	pthread_mutex_unlock(&st->lock);
}

static int cmd_regist(const Options *o)
{
	if(!o->host || !o->account_id || !o->pin)
		die("regist : --host, --account-id et --pin sont requis");

	ChiakiRegistInfo info;
	memset(&info, 0, sizeof(info));
	info.target = CHIAKI_TARGET_PS5_1;
	info.host = o->host;
	info.broadcast = false;
	info.psn_online_id = NULL;
	decode_account_id(o->account_id, info.psn_account_id);
	info.pin = (uint32_t)strtoul(o->pin, NULL, 10);

	RegistState st = { .done = false };
	pthread_mutex_init(&st.lock, NULL);
	pthread_cond_init(&st.cond, NULL);

	ChiakiRegist regist;
	if(chiaki_regist_start(&regist, &g_log, &info, regist_cb, &st) != CHIAKI_ERR_SUCCESS)
		die("démarrage de l'appairage impossible");

	pthread_mutex_lock(&st.lock);
	while(!st.done)
		pthread_cond_wait(&st.cond, &st.lock);
	pthread_mutex_unlock(&st.lock);
	chiaki_regist_fini(&regist);

	if(!st.ok)
		die("appairage refusé (PIN expiré ou incorrect, mauvais identifiant PSN, ou Remote Play désactivé)");

	char regist_key[CHIAKI_SESSION_AUTH_SIZE + 1] = { 0 };
	memcpy(regist_key, st.host.rp_regist_key, CHIAKI_SESSION_AUTH_SIZE);
	char morning[64];
	chiaki_base64_encode(st.host.rp_key, sizeof(st.host.rp_key), morning, sizeof(morning));
	char nick[128], key[64];
	const uint8_t *m = st.host.server_mac;
	printf("{\"regist_key\":\"%s\",\"morning\":\"%s\",\"nickname\":\"%s\",\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\"}\n",
		json_str(regist_key, key, sizeof(key)), morning, json_str(st.host.server_nickname, nick, sizeof(nick)),
		m[0], m[1], m[2], m[3], m[4], m[5]);
	return 0;
}

// --- stream ----------------------------------------------------------------

static ChiakiSession g_session;
static volatile sig_atomic_t g_stop_requested = 0;

static bool video_cb(uint8_t *buf, size_t buf_size, int32_t frames_lost, bool frame_recovered, void *user)
{
	(void)user;
	if(frames_lost > 0)
		emit_event("{\"type\":\"frames_lost\",\"count\":%d,\"recovered\":%s}", frames_lost, frame_recovered ? "true" : "false");
	emit(PKT_VIDEO, buf, buf_size);
	return true;
}

static void audio_header_cb(ChiakiAudioHeader *h, void *user)
{
	(void)user;
	emit_event("{\"type\":\"audio_header\",\"channels\":%u,\"bits\":%u,\"rate\":%u,\"frame_size\":%u}", h->channels, h->bits, h->rate, h->frame_size);
}

static void audio_frame_cb(uint8_t *buf, size_t buf_size, void *user)
{
	(void)user;
	emit(PKT_AUDIO, buf, buf_size);
}

static void event_cb(ChiakiEvent *event, void *user)
{
	(void)user;
	char tmp[256], tmp2[256];
	switch(event->type)
	{
		case CHIAKI_EVENT_CONNECTED:
			emit_event("{\"type\":\"connected\"}");
			break;
		case CHIAKI_EVENT_LOGIN_PIN_REQUEST:
			emit_event("{\"type\":\"login_pin_request\",\"incorrect\":%s}", event->login_pin_request.pin_incorrect ? "true" : "false");
			break;
		case CHIAKI_EVENT_NICKNAME_RECEIVED:
			emit_event("{\"type\":\"nickname\",\"name\":\"%s\"}", json_str(event->server_nickname, tmp, sizeof(tmp)));
			break;
		case CHIAKI_EVENT_QUIT:
			emit_event("{\"type\":\"quit\",\"reason\":\"%s\",\"detail\":\"%s\"}",
				json_str(chiaki_quit_reason_string(event->quit.reason), tmp, sizeof(tmp)),
				json_str(event->quit.reason_str, tmp2, sizeof(tmp2)));
			break;
		default:
			break;
	}
}

static bool read_exact(int fd, void *buf, size_t size)
{
	uint8_t *p = buf;
	while(size > 0)
	{
		ssize_t n = read(fd, p, size);
		if(n <= 0)
			return false;
		p += n;
		size -= (size_t)n;
	}
	return true;
}

static int16_t rd_i16(const uint8_t *p) { int16_t v; memcpy(&v, p, 2); return v; }

// Lit les commandes du serveur sur stdin. La fermeture de stdin arrête la session.
static void *stdin_thread(void *arg)
{
	(void)arg;
	ChiakiControllerState state;
	chiaki_controller_state_set_idle(&state);
	uint8_t header[5];
	uint8_t payload[256];

	while(read_exact(STDIN_FILENO, header, sizeof(header)))
	{
		uint32_t len;
		memcpy(&len, header + 1, 4);
		if(len > sizeof(payload))
			break;
		if(len && !read_exact(STDIN_FILENO, payload, len))
			break;

		switch(header[0])
		{
			case CMD_CONTROLLER:
				if(len >= 14)
				{
					memcpy(&state.buttons, payload, 4);
					state.l2_state = payload[4];
					state.r2_state = payload[5];
					state.left_x = rd_i16(payload + 6);
					state.left_y = rd_i16(payload + 8);
					state.right_x = rd_i16(payload + 10);
					state.right_y = rd_i16(payload + 12);
					chiaki_session_set_controller_state(&g_session, &state);
				}
				break;
			case CMD_IDR:
				chiaki_session_request_idr(&g_session);
				break;
			case CMD_PIN:
				chiaki_session_set_login_pin(&g_session, payload, len);
				break;
			case CMD_STOP:
				goto stop;
		}
	}
stop:
	g_stop_requested = 1;
	chiaki_session_stop(&g_session);
	return NULL;
}

static void on_signal(int sig)
{
	(void)sig;
	g_stop_requested = 1;
	chiaki_session_stop(&g_session);
}

static int cmd_stream(const Options *o)
{
	if(!o->host || !o->regist_key || !o->morning || !o->account_id)
		die("stream : --host, --regist-key, --morning et --account-id sont requis");

	ChiakiConnectInfo info;
	memset(&info, 0, sizeof(info));
	info.ps5 = true;
	info.host = o->host;

	size_t key_len = strlen(o->regist_key);
	if(key_len > CHIAKI_SESSION_AUTH_SIZE)
		die("--regist-key trop long");
	memcpy(info.regist_key, o->regist_key, key_len); // complété par des \0 (memset)

	uint8_t morning[64];
	size_t morning_size = sizeof(morning);
	if(chiaki_base64_decode(o->morning, strlen(o->morning), morning, &morning_size) != CHIAKI_ERR_SUCCESS
		|| morning_size != sizeof(info.morning))
		die("--morning invalide (attendu : 16 octets en base64)");
	memcpy(info.morning, morning, sizeof(info.morning));
	decode_account_id(o->account_id, info.psn_account_id);

	ChiakiVideoResolutionPreset res;
	switch(o->resolution)
	{
		case 360: res = CHIAKI_VIDEO_RESOLUTION_PRESET_360p; break;
		case 540: res = CHIAKI_VIDEO_RESOLUTION_PRESET_540p; break;
		case 720: res = CHIAKI_VIDEO_RESOLUTION_PRESET_720p; break;
		case 1080: res = CHIAKI_VIDEO_RESOLUTION_PRESET_1080p; break;
		default: die("--resolution doit valoir 360, 540, 720 ou 1080");
	}
	chiaki_connect_video_profile_preset(&info.video_profile, res, o->fps == 30 ? CHIAKI_VIDEO_FPS_PRESET_30 : CHIAKI_VIDEO_FPS_PRESET_60);
	if(o->bitrate > 0)
		info.video_profile.bitrate = (unsigned)o->bitrate;
	// H.264 : seul codec décodable par tous les navigateurs en WebRTC.
	info.video_profile.codec = CHIAKI_CODEC_H264;
	info.video_profile_auto_downgrade = true;
	info.enable_keyboard = false;
	info.enable_dualsense = false;
	info.audio_video_disabled = CHIAKI_NONE_DISABLED;
	info.packet_loss_max = 0.05;
	info.enable_idr_on_fec_failure = true;
	// Sans manette annoncée, la manette branchée sur la PS5 reste active (patch chiaki-spectator).
	info.spectator = o->spectator;

	ChiakiErrorCode err = chiaki_session_init(&g_session, &info, &g_log);
	if(err != CHIAKI_ERR_SUCCESS)
		die("chiaki_session_init : %s", chiaki_error_string(err));

	chiaki_session_set_event_cb(&g_session, event_cb, NULL);
	chiaki_session_set_video_sample_cb(&g_session, video_cb, NULL);
	ChiakiAudioSink sink = { .user = NULL, .header_cb = audio_header_cb, .frame_cb = audio_frame_cb };
	chiaki_session_set_audio_sink(&g_session, &sink);

	emit_event("{\"type\":\"video_profile\",\"width\":%u,\"height\":%u,\"fps\":%u,\"bitrate\":%u}",
		info.video_profile.width, info.video_profile.height, info.video_profile.max_fps, info.video_profile.bitrate);

	signal(SIGINT, on_signal);
	signal(SIGTERM, on_signal);
	signal(SIGPIPE, SIG_IGN);

	err = chiaki_session_start(&g_session);
	if(err != CHIAKI_ERR_SUCCESS)
		die("chiaki_session_start : %s", chiaki_error_string(err));

	pthread_t input;
	pthread_create(&input, NULL, stdin_thread, NULL);
	pthread_detach(input);

	chiaki_session_join(&g_session);
	chiaki_session_fini(&g_session);
	return 0;
}

// --- main ------------------------------------------------------------------

static void usage(void)
{
	fprintf(stderr,
		"usage : couchcast-bridge <discover|wakeup|regist|stream> [options]\n"
		"  --host IP  --regist-key KEY  --morning B64  --account-id B64  --pin PIN\n"
		"  --resolution 360|540|720|1080 (1080)  --fps 30|60 (60)  --bitrate KBPS  --timeout S (3)  --spectator  --verbose\n");
	exit(2);
}

int main(int argc, char **argv)
{
	if(argc < 2)
		usage();
	const char *cmd = argv[1];

	Options o = { .resolution = 1080, .fps = 60, .timeout = 3.0 };
	static const struct option long_opts[] = {
		{ "host", required_argument, 0, 'h' },
		{ "regist-key", required_argument, 0, 'k' },
		{ "morning", required_argument, 0, 'm' },
		{ "account-id", required_argument, 0, 'a' },
		{ "pin", required_argument, 0, 'p' },
		{ "resolution", required_argument, 0, 'r' },
		{ "fps", required_argument, 0, 'f' },
		{ "bitrate", required_argument, 0, 'b' },
		{ "timeout", required_argument, 0, 't' },
		{ "verbose", no_argument, 0, 'v' },
		{ "spectator", no_argument, 0, 's' },
		{ 0, 0, 0, 0 },
	};
	optind = 2;
	int c;
	while((c = getopt_long(argc, argv, "", long_opts, NULL)) != -1)
	{
		switch(c)
		{
			case 'h': o.host = optarg; break;
			case 'k': o.regist_key = optarg; break;
			case 'm': o.morning = optarg; break;
			case 'a': o.account_id = optarg; break;
			case 'p': o.pin = optarg; break;
			case 'r': o.resolution = atoi(optarg); break;
			case 'f': o.fps = atoi(optarg); break;
			case 'b': o.bitrate = atoi(optarg); break;
			case 't': o.timeout = atof(optarg); break;
			case 'v': o.verbose = true; break;
			case 's': o.spectator = true; break;
			default: usage();
		}
	}

	if(chiaki_lib_init() != CHIAKI_ERR_SUCCESS)
		die("chiaki_lib_init a échoué");
	uint32_t mask = o.verbose ? CHIAKI_LOG_ALL : (CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO);
	chiaki_log_init(&g_log, mask, log_cb, NULL);

	if(strcmp(cmd, "discover") == 0)
		return cmd_discover(&o);
	if(strcmp(cmd, "wakeup") == 0)
		return cmd_wakeup(&o);
	if(strcmp(cmd, "regist") == 0)
		return cmd_regist(&o);
	if(strcmp(cmd, "stream") == 0)
		return cmd_stream(&o);
	usage();
	return 2;
}
