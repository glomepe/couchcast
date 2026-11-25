cmake_minimum_required(VERSION 3.16)
project(couchcast-bridge C)

# Uniquement la bibliothèque de chiaki-ng : pas d'interface, pas de décodeur.
set(CHIAKI_ENABLE_TESTS OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_CLI OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_GUI OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_SETSU OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_STEAMDECK_NATIVE OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_STEAM_SHORTCUT OFF CACHE BOOL "" FORCE)
set(CHIAKI_ENABLE_FFMPEG_DECODER OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_PI_DECODER OFF CACHE STRING "" FORCE)
set(CHIAKI_ENABLE_SPEEX OFF CACHE STRING "" FORCE)
set(CHIAKI_USE_SYSTEM_CURL ON CACHE STRING "" FORCE)

add_subdirectory(../third_party/chiaki-ng chiaki EXCLUDE_FROM_ALL)

add_executable(couchcast-bridge src/main.c)
target_link_libraries(couchcast-bridge chiaki-lib)
set_target_properties(couchcast-bridge PROPERTIES C_STANDARD 11)
